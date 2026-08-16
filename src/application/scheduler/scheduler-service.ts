import { createHash } from "node:crypto";

import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import { evaluatePaymentTransition } from "../../domain/payments/payment-state-machine.js";
import {
  WebhookOutboxWriter,
  type WebhookDispatcher,
} from "../webhooks/webhook-outbox.js";
import { appendAuditEntryInTransaction } from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { withRequiredTransaction } from "../../infrastructure/mongodb/transactions.js";
import type { JobLease } from "../../infrastructure/redis/job-lease.js";
import type { PaymentConfirmationEnqueuer } from "../processing/payment-matching-service.js";

export interface SchedulerJobReport {
  readonly job: string;
  readonly ranAt: string;
  readonly affected: number;
}

interface ExpirablePayment {
  readonly paymentId: string;
  readonly merchantId: string;
  readonly chain: string;
  readonly token: string;
  readonly amount: string;
  readonly status: string;
  readonly version: number;
  readonly requiredConfirmations: number;
  readonly expiresAt: Date;
  readonly partialAmountReceived?: string;
}

function annotationIdFor(
  entityType: string,
  entityId: string,
  category: string,
): string {
  const digest = createHash("sha256")
    .update(`${entityType}:${entityId}:${category}`)
    .digest("hex");
  return `ann_${digest.slice(0, 40)}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === 11_000
  );
}

/**
 * Scheduled job runner (ADR 0015). Every tick is guarded by a Redis lease
 * and every effect is idempotent at the database layer (legal conditional
 * transitions, deterministic job ids, deduplicated annotations), so
 * overlapping schedulers or lease expiry mid-run cannot double-apply.
 */
export class SchedulerService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #config: RuntimeConfig;
  readonly #lease: JobLease;
  readonly #confirmations: PaymentConfirmationEnqueuer | undefined;
  readonly #webhookDispatcher: WebhookDispatcher | undefined;
  readonly #outbox: WebhookOutboxWriter | undefined;
  readonly #logger: Logger;
  readonly #timers: NodeJS.Timeout[] = [];

  public constructor(
    connection: Connection,
    config: RuntimeConfig,
    lease: JobLease,
    logger: Logger,
    options: {
      readonly confirmations?: PaymentConfirmationEnqueuer;
      readonly webhookDispatcher?: WebhookDispatcher;
    } = {},
  ) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#config = config;
    this.#lease = lease;
    this.#confirmations = options.confirmations;
    this.#webhookDispatcher = options.webhookDispatcher;
    this.#outbox =
      options.webhookDispatcher === undefined
        ? undefined
        : new WebhookOutboxWriter(connection);
    this.#logger = logger.child({ component: "scheduler" });
  }

  public start(): void {
    const jobs: readonly [string, number, () => Promise<number>][] = [
      [
        "expiry-sweep",
        this.#config.scheduler.expirySweepSec,
        () => this.expireDuePayments(),
      ],
      [
        "confirmation-recheck",
        this.#config.scheduler.confirmationRecheckSec,
        () => this.recheckConfirmations(),
      ],
      [
        "stuck-payments",
        this.#config.scheduler.stuckPaymentSec,
        () => this.detectStuckPayments(),
      ],
      [
        "screening-recheck",
        this.#config.scheduler.screeningRecheckSec,
        () => this.screeningRecheckWrapper(),
      ],
      [
        "registry-refresh",
        this.#config.scheduler.registryRefreshSec,
        () => this.refreshRegistry(),
      ],
      [
        "webhook-sweep",
        this.#config.scheduler.webhookSweepSec,
        () => this.sweepWebhookOutbox(),
      ],
      ["retention", this.#config.scheduler.retentionSec, () => this.applyRetention()],
    ];
    for (const [job, intervalSec, run] of jobs) {
      const timer = setInterval(() => {
        void this.#guarded(job, run);
      }, intervalSec * 1_000);
      timer.unref();
      this.#timers.push(timer);
    }
  }

  public stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.length = 0;
  }

  async #guarded(job: string, run: () => Promise<number>): Promise<void> {
    try {
      if (!(await this.#lease.acquire(job))) return;
      const affected = await run();
      if (affected > 0) {
        this.#logger.info({ job, affected }, "Scheduled job completed");
      }
    } catch (error: unknown) {
      this.#logger.warn(
        { err: error, job },
        "Scheduled job failed; retrying next tick",
      );
    }
  }

  /**
   * Expiry sweep: proactively transition `pending` payments past expiry
   * through the same legal state-machine guard, audit, and webhook outbox
   * as the event-driven path — never a raw status update.
   */
  public async expireDuePayments(limit = 100): Promise<number> {
    const now = new Date();
    const due = await this.#models.Payment.find({
      status: "pending",
      expiresAt: { $lt: now },
    })
      .limit(limit)
      .lean();
    let expired = 0;
    for (const raw of due) {
      const payment = raw as unknown as ExpirablePayment;
      const claims = await this.#models.OnChainEvent.find({
        matchedPaymentId: payment.paymentId,
        canonical: true,
      })
        .select({ amount: 1, verifiedReceivedAmount: 1 })
        .lean();
      const total = claims.reduce((sum, claim) => {
        const amount = claim.verifiedReceivedAmount ?? claim.amount;
        return sum + BigInt(amount);
      }, 0n);
      const evaluation = evaluatePaymentTransition({
        from: "pending",
        to: "expired",
        now,
        expiresAt: payment.expiresAt,
        reorgGraceMs: this.#config.processing.latePaymentGraceSec * 1000,
        confirmations: 0,
        requiredConfirmations: payment.requiredConfirmations,
        canonical: true,
        complianceClear: true,
        qualifyingEventClaimed: total >= BigInt(payment.amount),
      });
      if (!evaluation.legal) continue;
      let deliveryId: string | undefined;
      await withRequiredTransaction(this.#connection, async (session) => {
        const updated = await this.#models.Payment.findOneAndUpdate(
          { paymentId: payment.paymentId, status: "pending", version: payment.version },
          {
            $set: {
              status: "expired",
              terminalAt: now,
              partialAmountReceived: total.toString(10),
              underpaymentFlag: total > 0n && total < BigInt(payment.amount),
            },
            $inc: { version: 1 },
          },
          { session },
        );
        if (updated === null) return;
        await appendAuditEntryInTransaction(
          this.#connection,
          {
            scope: `merchant_${payment.merchantId}`,
            entityType: "Payment",
            entityId: payment.paymentId,
            action: "payment_expired",
            actorType: "system",
            actorId: "scheduler",
            before: { status: "pending" },
            after: { status: "expired", partialAmountReceived: total.toString(10) },
          },
          session,
        );
        if (this.#outbox !== undefined) {
          deliveryId = await this.#outbox.writeInTransaction(
            session,
            WebhookOutboxWriter.payloadFor(
              {
                ...payment,
                status: "expired",
                partialAmountReceived: total.toString(10),
              },
              "payment.expired",
              now,
            ),
          );
        }
        expired += 1;
      });
      if (total > 0n && total < BigInt(payment.amount)) {
        await this.#annotateStale(
          "Payment",
          payment.paymentId,
          payment.merchantId,
          "partial",
          "Expired with partial transfers; held for manual refund/reconciliation review",
        );
      }
      if (deliveryId !== undefined) {
        await this.#webhookDispatcher?.enqueueWebhookDelivery(deliveryId);
      }
    }
    return expired;
  }

  /** Re-enqueue lost confirmation jobs (jobId dedupe collapses). */
  public async recheckConfirmations(limit = 200): Promise<number> {
    if (this.#confirmations === undefined) return 0;
    const active = await this.#models.Payment.find({
      status: { $in: ["matched", "confirming"] },
    })
      .select({ paymentId: 1 })
      .limit(limit)
      .lean();
    for (const payment of active) {
      await this.#confirmations.enqueueConfirmation(payment.paymentId);
    }
    return active.length;
  }

  /** Surface stale matched/confirming payments (annotated, never hidden). */
  public async detectStuckPayments(): Promise<number> {
    const threshold = new Date(
      Date.now() - this.#config.scheduler.stuckPaymentThresholdSec * 1000,
    );
    const stuck = await this.#models.Payment.find({
      status: { $in: ["matched", "confirming"] },
      updatedAt: { $lt: threshold },
    })
      .select({ paymentId: 1, merchantId: 1 })
      .limit(100)
      .lean();
    for (const payment of stuck) {
      await this.#annotateStale(
        "Payment",
        payment.paymentId,
        payment.merchantId,
        "stale",
        "Matched or confirming beyond the staleness threshold; investigate RPC or reorg state",
      );
      this.#logger.error(
        { paymentId: payment.paymentId, merchantId: payment.merchantId },
        "stuck_payment_detected",
      );
    }
    return stuck.length;
  }

  async screeningRecheckWrapper(): Promise<number> {
    // Delegates to the compliance service's held-payment re-screen through
    // the provider; the wiring lives with the runtime.
    return this.#screeningRecheck?.() ?? 0;
  }

  #screeningRecheck: (() => Promise<number>) | undefined;

  public bindScreeningRecheck(fn: () => Promise<number>): void {
    this.#screeningRecheck = fn;
  }

  /** Refresh the enabled-registry snapshot (converges with the watcher). */
  public async refreshRegistry(): Promise<number> {
    const { EnabledRegistryReader } = await import("../registry/registry-reader.js");
    const reader = new EnabledRegistryReader(this.#connection);
    const snapshot = await reader.refresh();
    this.#logger.debug(
      { revision: snapshot.revision.slice(0, 12), chains: snapshot.chains.length },
      "Registry snapshot refreshed",
    );
    return snapshot.chains.length;
  }

  /** Re-enqueue due pending webhook rows whose enqueue was lost (ADR 0014). */
  public async sweepWebhookOutbox(limit = 100): Promise<number> {
    if (this.#webhookDispatcher === undefined) return 0;
    const due = await this.#models.WebhookDelivery.find({
      status: { $in: ["pending", "delivering"] },
      $or: [{ nextAttemptAt: { $lte: new Date() } }, { nextAttemptAt: null }],
    })
      .select({ deliveryId: 1 })
      .limit(limit)
      .lean();
    for (const row of due) {
      await this.#webhookDispatcher.enqueueWebhookDelivery(row.deliveryId);
    }
    return due.length;
  }

  /** Retention: set completion expiry on delivered rows missing one. */
  public async applyRetention(): Promise<number> {
    const result = await this.#models.WebhookDelivery.updateMany(
      { status: "delivered", expiresAt: null },
      {
        $set: {
          expiresAt: new Date(Date.now() + this.#config.webhooks.retentionSec * 1000),
        },
      },
    );
    return result.modifiedCount;
  }

  async #annotateStale(
    entityType: "Payment",
    entityId: string,
    merchantId: string,
    category: "stale" | "partial",
    note: string,
  ): Promise<void> {
    const annotationId = annotationIdFor(entityType, entityId, category);
    try {
      await this.#models.ReconciliationAnnotation.create({
        annotationId,
        entityType,
        entityId,
        merchantId,
        category,
        status: "open",
        note,
        createdBy: "scheduler",
        createdAt: new Date(),
      });
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
}
