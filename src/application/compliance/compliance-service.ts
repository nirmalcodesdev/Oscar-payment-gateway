import { createHash, randomUUID } from "node:crypto";

import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { AdminPrincipal } from "../auth/principals.js";
import { appendAuditEntryInTransaction } from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { withRequiredTransaction } from "../../infrastructure/mongodb/transactions.js";
import type { UpdateableSanctionsListProvider } from "../../infrastructure/compliance/updateable-list-provider.js";

const maximumListEntries = 100_000;
const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;

export interface SanctionsListIngestInput {
  readonly listVersion: string;
  readonly source: string;
  readonly addresses: readonly string[];
  readonly contentSha256: string;
}

export interface SanctionsListIngestResult {
  readonly listId: string;
  readonly listVersion: string;
  readonly entryCount: number;
  readonly contentHash: string;
  readonly replacedVersion: string | undefined;
  readonly rescreened: {
    readonly cleared: number;
    readonly stillHeld: number;
  };
}

export interface ComplianceHoldView {
  readonly paymentId: string;
  readonly merchantId: string;
  readonly chain: string;
  readonly amount: string;
  readonly status: string;
  readonly screeningStatus: string;
  readonly heldSince: Date;
  readonly latestReview:
    | {
        readonly decision: string;
        readonly reason: string;
        readonly reviewedBy: string;
        readonly reviewedAt: Date;
      }
    | undefined;
}

export interface ReviewDecisionInput {
  readonly paymentId: string;
  readonly decision: "release" | "block";
  readonly reason: string;
  readonly evidence?: string;
}

export interface SanctionsListRetireResult {
  readonly listId: string;
  readonly listVersion: string | undefined;
  readonly retired: boolean;
}

/**
 * Canonical content hash over the sorted unique normalized addresses
 * (ADR 0013): deterministic on both the submitting operator's side and the
 * server, so transport corruption cannot silently alter the list.
 */
export function sanctionsListContentHash(
  normalizedAddresses: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([...new Set(normalizedAddresses)].sort()))
    .digest("hex");
}

/**
 * Admin compliance controls (ADR 0013): controlled sanctions-list updates
 * with integrity verification, the held-payment review queue, audited
 * review decisions, and post-update re-screening of held payments.
 */
export class ComplianceService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #provider: UpdateableSanctionsListProvider | undefined;
  readonly #logger: Logger;

  public constructor(
    connection: Connection,
    logger: Logger,
    provider?: UpdateableSanctionsListProvider,
  ) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#provider = provider;
    this.#logger = logger.child({ component: "compliance-service" });
  }

  public async ingestSanctionsList(
    principal: AdminPrincipal,
    input: SanctionsListIngestInput,
  ): Promise<SanctionsListIngestResult> {
    if (input.addresses.length === 0) {
      throw new ComplianceControlError(
        "VALIDATION_ERROR",
        "List must contain at least one address",
        400,
      );
    }
    if (input.addresses.length > maximumListEntries) {
      throw new ComplianceControlError(
        "VALIDATION_ERROR",
        `List exceeds the maximum of ${maximumListEntries} entries`,
        400,
      );
    }
    const normalized = [
      ...new Set(input.addresses.map((address) => address.toLowerCase())),
    ];
    if (normalized.some((address) => !evmAddressPattern.test(address))) {
      throw new ComplianceControlError(
        "VALIDATION_ERROR",
        "List contains a malformed address",
        400,
      );
    }
    const computedHash = sanctionsListContentHash(normalized);
    if (computedHash !== input.contentSha256.toLowerCase()) {
      throw new ComplianceControlError(
        "VALIDATION_ERROR",
        "Content hash does not match the submitted addresses",
        400,
      );
    }

    const listId = `sanctions_${randomUUID()}`;
    const ingestedAt = new Date();
    let replacedVersion: string | undefined;
    await withRequiredTransaction(this.#connection, async (session) => {
      const active = await this.#models.SanctionsList.findOne({
        status: "active",
      }).session(session);
      if (active !== null) {
        replacedVersion = active.listVersion;
        await this.#models.SanctionsList.updateOne(
          { listId: active.listId, status: "active" },
          { $set: { status: "retired", retiredAt: ingestedAt } },
          { session },
        );
      }
      await this.#models.SanctionsList.create(
        [
          {
            listId,
            listVersion: input.listVersion,
            source: input.source,
            contentHash: computedHash,
            entryCount: normalized.length,
            status: "active",
            ingestedAt,
            version: 0,
          },
        ],
        { session, ordered: true },
      );
      await this.#models.SanctionsAddress.insertMany(
        normalized.map((address) => ({ listId, normalizedAddress: address })),
        { session, ordered: true },
      );
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "compliance_sanctions_list",
          entityType: "SanctionsList",
          entityId: listId,
          action: "sanctions_list_updated",
          actorType: "admin",
          actorId: principal.adminId,
          before: { listVersion: replacedVersion },
          after: {
            listVersion: input.listVersion,
            entryCount: normalized.length,
            contentHash: computedHash,
            source: input.source,
          },
        },
        session,
      );
    });

    this.#provider?.invalidate();
    const rescreened = await this.rescreenHeldPayments();
    return {
      listId,
      listVersion: input.listVersion,
      entryCount: normalized.length,
      contentHash: computedHash,
      replacedVersion,
      rescreened,
    };
  }

  /**
   * Restore the "no managed list" state (ADR 0017): atomically retire the
   * active list, if any, with the same append-only audit discipline as ingest,
   * then invalidate the shared provider cache so the environment static list is
   * served again. Adopted by the development-gated admin control so both the
   * database and the API's in-process cache are reset deterministically.
   * Retired lists are retained for audit; nothing is deleted.
   */
  public async retireActiveSanctionsList(
    principal: AdminPrincipal,
  ): Promise<SanctionsListRetireResult> {
    const retiredAt = new Date();
    let retired: { listId: string; listVersion: string } | undefined;
    await withRequiredTransaction(this.#connection, async (session) => {
      const active = await this.#models.SanctionsList.findOne({
        status: "active",
      }).session(session);
      if (active !== null) {
        await this.#models.SanctionsList.updateOne(
          { listId: active.listId, status: "active" },
          { $set: { status: "retired", retiredAt } },
          { session },
        );
        retired = { listId: active.listId, listVersion: active.listVersion };
      }
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "compliance_sanctions_list",
          entityType: "SanctionsList",
          entityId: active?.listId ?? "active",
          action: "sanctions_list_updated",
          actorType: "admin",
          actorId: principal.adminId,
          before: { listVersion: active?.listVersion },
          after: { listVersion: null },
        },
        session,
      );
    });

    this.#provider?.invalidate();
    return {
      listId: retired?.listId ?? "no active",
      listVersion: retired?.listVersion,
      retired: retired !== undefined,
    };
  }

  public async listHolds(limit: number): Promise<readonly ComplianceHoldView[]> {
    const held = await this.#models.Payment.find({
      status: { $in: ["pending", "matched", "confirming"] },
      screeningStatus: { $in: ["flagged", "blocked", "pending"] },
    })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();
    const views: ComplianceHoldView[] = [];
    for (const payment of held) {
      const latestReview = await this.#models.ComplianceReview.findOne({
        paymentId: payment.paymentId,
      })
        .sort({ reviewedAt: -1 })
        .lean();
      views.push({
        paymentId: payment.paymentId,
        merchantId: payment.merchantId,
        chain: payment.chain,
        amount: payment.amount,
        status: payment.status,
        screeningStatus: payment.screeningStatus,
        heldSince: (payment as { updatedAt?: Date }).updatedAt ?? new Date(0),
        latestReview:
          latestReview === null
            ? undefined
            : {
                decision: latestReview.decision,
                reason: latestReview.reason,
                reviewedBy: latestReview.reviewedBy,
                reviewedAt: latestReview.reviewedAt,
              },
      });
    }
    return views;
  }

  public async recordReviewDecision(
    principal: AdminPrincipal,
    input: ReviewDecisionInput,
  ): Promise<{ readonly reviewId: string; readonly decision: string }> {
    const payment = await this.#models.Payment.findOne({
      paymentId: input.paymentId,
    }).lean();
    if (payment === null) {
      throw new ComplianceControlError("NOT_FOUND", "Payment not found", 404);
    }
    const reviewId = `review_${randomUUID()}`;
    const reviewedAt = new Date();
    await withRequiredTransaction(this.#connection, async (session) => {
      await this.#models.ComplianceReview.create(
        [
          {
            reviewId,
            paymentId: input.paymentId,
            decision: input.decision,
            reason: input.reason,
            ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
            reviewedBy: principal.adminId,
            reviewedAt,
          },
        ],
        { session, ordered: true },
      );
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: `merchant_${payment.merchantId}`,
          entityType: "Payment",
          entityId: input.paymentId,
          action: "compliance_review_decision",
          actorType: "admin",
          actorId: principal.adminId,
          before: { screeningStatus: payment.screeningStatus },
          after: { decision: input.decision, reviewId },
          metadata: { reason: input.reason },
        },
        session,
      );
    });

    if (input.decision === "block") {
      await this.#models.Payment.updateOne(
        { paymentId: input.paymentId, version: payment.version },
        { $set: { screeningStatus: "blocked" }, $inc: { version: 1 } },
      );
    }
    return { reviewId, decision: input.decision };
  }

  /**
   * Latest review decision for a payment, used by the confirmation gate:
   * an active `release` covers a non-clear fresh screen; a `block` pins the
   * hold.
   */
  public async latestDecision(
    paymentId: string,
  ): Promise<"release" | "block" | undefined> {
    const latest = await this.#models.ComplianceReview.findOne({ paymentId })
      .sort({ reviewedAt: -1 })
      .lean();
    return latest?.decision as "release" | "block" | undefined;
  }

  /**
   * Re-screen held payments after a list update (ADR 0013): clearing
   * results update `screeningStatus` through conditional writes; blocked
   * or unavailable results keep the hold. Payment version conflicts are
   * skipped — the next confirmation attempt re-evaluates.
   */
  public async rescreenHeldPayments(): Promise<{ cleared: number; stillHeld: number }> {
    if (this.#provider === undefined) return { cleared: 0, stillHeld: 0 };
    const held = await this.#models.Payment.find({
      status: { $in: ["pending", "matched", "confirming"] },
      screeningStatus: { $in: ["flagged", "blocked", "pending"] },
    })
      .select({ paymentId: 1, version: 1 })
      .lean();
    let cleared = 0;
    let stillHeld = 0;
    for (const payment of held) {
      try {
        const result = await this.#provider.screen({
          // The destination re-screen covers the merchant address; sender
          // re-screening happens at the confirmation gate with fresh data.
          address: await this.#destinationAddress(payment.paymentId),
          chain: await this.#paymentChain(payment.paymentId),
        });
        if (result.verdict === "clear") {
          const updated = await this.#models.Payment.updateOne(
            { paymentId: payment.paymentId, version: payment.version },
            { $set: { screeningStatus: "clear" }, $inc: { version: 1 } },
          );
          if (updated.modifiedCount === 1) cleared += 1;
          else stillHeld += 1;
        } else {
          stillHeld += 1;
        }
      } catch (error: unknown) {
        this.#logger.warn(
          { err: error, paymentId: payment.paymentId },
          "Held-payment re-screen failed; the hold stands",
        );
        stillHeld += 1;
      }
    }
    return { cleared, stillHeld };
  }

  async #destinationAddress(paymentId: string): Promise<string> {
    const payment = await this.#models.Payment.findOne({ paymentId })
      .select({ walletAddressId: 1 })
      .lean();
    if (payment === null) throw new Error(`Payment ${paymentId} not found`);
    const wallet = await this.#models.WalletAddress.findOne({
      walletAddressId: payment.walletAddressId,
    })
      .select({ address: 1 })
      .lean();
    if (wallet === null) throw new Error("Payment wallet address not found");
    return wallet.address;
  }

  async #paymentChain(paymentId: string): Promise<string> {
    const payment = await this.#models.Payment.findOne({ paymentId })
      .select({ chain: 1 })
      .lean();
    if (payment === null) throw new Error(`Payment ${paymentId} not found`);
    return payment.chain;
  }
}

export class ComplianceControlError extends Error {
  public constructor(
    public readonly code: "VALIDATION_ERROR" | "NOT_FOUND",
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ComplianceControlError";
  }
}
