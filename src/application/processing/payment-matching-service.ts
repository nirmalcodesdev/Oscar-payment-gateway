import { createHash } from "node:crypto";

import type { ClientSession, Connection } from "mongoose";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import { evaluatePaymentTransition } from "../../domain/payments/payment-state-machine.js";
import {
  WebhookOutboxWriter,
  type WebhookDispatcher,
} from "../webhooks/webhook-outbox.js";
import {
  appendAuditEntry,
  appendAuditEntryInTransaction,
} from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { withRequiredTransaction } from "../../infrastructure/mongodb/transactions.js";
import type { PaymentLock } from "../../infrastructure/redis/payment-lock.js";

export type MatchAction =
  | "claimed_matched"
  | "claimed_partial"
  | "replacement_linked"
  | "excess_linked"
  | "late_arrival_annotated"
  | "orphan_annotated"
  | "skipped";

export interface MatchOutcome {
  readonly eventId: string;
  readonly action: MatchAction;
  readonly paymentId?: string;
}

/** Internal match result carrying follow-up work for after the commit. */
type ClaimOutcome = MatchOutcome & {
  readonly postTransaction?: () => Promise<void>;
  readonly deliveryIds?: readonly string[];
};

export interface PaymentConfirmationEnqueuer {
  enqueueConfirmation(paymentId: string): Promise<void>;
}

interface EventDocument {
  readonly eventId: string;
  readonly chain: string;
  readonly token?: string;
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly amount: string;
  readonly verifiedReceivedAmount?: string;
  readonly canonical: boolean;
  readonly interpretationStatus?: string;
  readonly matchedPaymentId?: string;
}

interface PaymentDocument {
  readonly paymentId: string;
  readonly merchantId: string;
  readonly chain: string;
  readonly token: string;
  readonly amount: string;
  readonly status: string;
  readonly version: number;
  readonly requiredConfirmations: number;
  readonly expiresAt: Date;
  readonly matchedEventId?: string;
}

/**
 * Raised inside the claim transaction when the routing decision changed under
 * us (another worker moved the payment first). Aborting rolls back the claim
 * so no event is ever left claimed against an unadvanced payment; the outer
 * handler records the rejected attempt as an auditable no-op and the event's
 * next delivery (or the queue retry) re-routes against the fresh state.
 */
class ClaimRoutingAbortedError extends Error {
  public constructor(
    public readonly reason:
      | "payment_changed_concurrently"
      | "payment_terminal"
      | "tolerance_exceeded",
  ) {
    super(`Claim routing aborted: ${reason}`);
    this.name = "ClaimRoutingAbortedError";
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === 11_000
  );
}

function effectiveAmount(event: EventDocument): bigint {
  return BigInt(event.verifiedReceivedAmount ?? event.amount);
}

function baseUnit(value: bigint): string {
  return value.toString(10);
}

/**
 * Deterministic annotation identity so repeated delivery of the same event
 * cannot stack duplicate reconciliation entries; the unique annotationId
 * index collapses them.
 */
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

/**
 * Matches interpreted accepted events to payments and executes the guarded
 * state machine (ADR 0011). All claim and transition writes happen inside one
 * replica-set transaction whose payment reads are session-scoped, so a
 * payment that moved concurrently aborts the claim instead of committing it.
 * The unique `matchedPaymentId` claim index and the conditional status and
 * version writes remain the correctness boundary; the payment lock only
 * reduces contention.
 */
export class PaymentMatchingService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #config: RuntimeConfig;
  readonly #lock: PaymentLock | undefined;
  readonly #confirmations: PaymentConfirmationEnqueuer | undefined;
  readonly #outbox: WebhookOutboxWriter | undefined;
  readonly #dispatcher: WebhookDispatcher | undefined;

  public constructor(
    connection: Connection,
    config: RuntimeConfig,
    options: {
      readonly lock?: PaymentLock;
      readonly confirmations?: PaymentConfirmationEnqueuer;
      readonly webhookDispatcher?: WebhookDispatcher;
    } = {},
  ) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#config = config;
    this.#lock = options.lock;
    this.#confirmations = options.confirmations;
    this.#outbox =
      options.webhookDispatcher === undefined
        ? undefined
        : new WebhookOutboxWriter(connection);
    this.#dispatcher = options.webhookDispatcher;
  }

  public async matchEvent(eventId: string, logger: Logger): Promise<MatchOutcome> {
    const raw = await this.#models.OnChainEvent.findOne({ eventId }).lean();
    if (raw === null) {
      throw new Error(`On-chain event ${eventId} was not found`);
    }
    const event = raw as unknown as EventDocument;
    if (event.interpretationStatus !== "accepted") {
      return { eventId, action: "skipped" };
    }
    if (!event.canonical) {
      // Orphaned by a reorg; replacement blocks carry their own new events.
      return { eventId, action: "skipped" };
    }

    const walletAddress = await this.#models.WalletAddress.findOne({
      chain: event.chain,
      normalizedAddress: raw.normalizedToAddress,
      status: "assigned",
    }).lean();
    const assigned = walletAddress?.assignedPaymentId;
    if (typeof assigned !== "string") {
      await this.#annotate(
        "OnChainEvent",
        eventId,
        "orphan",
        "Deposit targets an address with no open payment assignment",
      );
      return { eventId, action: "orphan_annotated" };
    }
    const paymentId = assigned;

    const paymentRaw = await this.#models.Payment.findOne({ paymentId }).lean();
    if (paymentRaw === null) {
      await this.#annotate(
        "OnChainEvent",
        event.eventId,
        "orphan",
        "Assigned payment no longer exists",
      );
      return { eventId, action: "orphan_annotated" };
    }
    const payment = paymentRaw as unknown as PaymentDocument;

    if (payment.chain !== event.chain || payment.token !== event.token) {
      // Recipient matches but the deposit is not the payment's token
      // identity; the money is real but not claimable by this payment.
      await this.#annotate(
        "OnChainEvent",
        event.eventId,
        "orphan",
        "Deposit token identity does not match the assigned payment",
      );
      return { eventId, action: "orphan_annotated", paymentId };
    }

    const run = (): Promise<ClaimOutcome> => this.#applyClaim(event, paymentId);
    let outcome: ClaimOutcome;
    try {
      outcome =
        this.#lock === undefined
          ? await run()
          : await this.#lock.withLock(paymentId, run);
    } catch (error: unknown) {
      if (error instanceof ClaimRoutingAbortedError) {
        await this.#handleAbortedClaim(event, payment, error.reason, logger);
        return { eventId: event.eventId, action: "skipped", paymentId };
      }
      throw error;
    }

    if (
      outcome.action === "claimed_matched" ||
      outcome.action === "replacement_linked"
    ) {
      await this.#confirmations?.enqueueConfirmation(paymentId);
    }
    if (outcome.postTransaction !== undefined) {
      await outcome.postTransaction();
    }
    if (outcome.deliveryIds !== undefined && this.#dispatcher !== undefined) {
      for (const deliveryId of outcome.deliveryIds) {
        await this.#dispatcher.enqueueWebhookDelivery(deliveryId);
      }
    }
    return outcome;
  }

  /**
   * The single claim transaction. The payment is re-read inside the session
   * so routing sees snapshot-consistent state; every write is conditional on
   * that state's version, and any routing surprise aborts the whole claim.
   */
  async #applyClaim(event: EventDocument, paymentId: string): Promise<ClaimOutcome> {
    return withRequiredTransaction(this.#connection, async (session) => {
      const paymentRaw = await this.#models.Payment.findOne({ paymentId })
        .session(session)
        .lean();
      if (paymentRaw === null) {
        throw new ClaimRoutingAbortedError("payment_terminal");
      }
      const payment = paymentRaw as unknown as PaymentDocument;
      const now = new Date();
      const expired = now.getTime() > payment.expiresAt.getTime();

      if (
        payment.status === "confirmed" ||
        payment.status === "expired" ||
        payment.status === "failed"
      ) {
        // Terminal: never claim; annotate outside the transaction.
        return {
          eventId: event.eventId,
          action: "late_arrival_annotated",
          paymentId,
          postTransaction: () =>
            this.#annotate(
              "OnChainEvent",
              event.eventId,
              "late",
              "Deposit arrived for a payment already in a terminal state; routed to manual reconciliation",
              payment.merchantId,
            ),
        };
      }

      if (payment.status === "pending" && expired) {
        return this.#expireInTransaction(session, event, payment, now);
      }

      const claimed = await this.#claimEvent(event.eventId, paymentId, session);
      if (!claimed) {
        // Another payment owns this event forever; nothing to do here.
        return { eventId: event.eventId, action: "skipped", paymentId };
      }

      const cumulative = await this.#cumulativeIncluding(event, paymentId, session);
      const amount = BigInt(payment.amount);

      if (cumulative < amount) {
        const updated = await this.#models.Payment.findOneAndUpdate(
          { paymentId, status: "pending", version: payment.version },
          {
            $set: {
              partialAmountReceived: baseUnit(cumulative),
              underpaymentFlag: true,
            },
            $inc: { version: 1 },
          },
          { session },
        );
        if (updated === null) {
          throw new ClaimRoutingAbortedError("payment_changed_concurrently");
        }
        await appendAuditEntryInTransaction(
          this.#connection,
          {
            scope: `merchant_${payment.merchantId}`,
            entityType: "Payment",
            entityId: paymentId,
            action: "payment_partial_accumulated",
            actorType: "system",
            actorId: "processor",
            before: { status: "pending" },
            after: {
              status: "pending",
              partialAmountReceived: baseUnit(cumulative),
              eventId: event.eventId,
            },
            eventId: event.eventId,
            transactionHash: event.transactionHash,
          },
          session,
        );
        return { eventId: event.eventId, action: "claimed_partial", paymentId };
      }

      if (!this.#config.processing.overpaymentAllow && cumulative > amount) {
        // Operator disabled overpayment tolerance. The claim must not stand:
        // roll back and record the deposit for manual review outside.
        throw new ClaimRoutingAbortedError("tolerance_exceeded");
      }

      const excess = cumulative > amount ? cumulative - amount : 0n;

      if (payment.status === "pending") {
        const evaluation = evaluatePaymentTransition({
          from: "pending",
          to: "matched",
          now,
          expiresAt: payment.expiresAt,
          reorgGraceMs: this.#config.processing.latePaymentGraceSec * 1000,
          confirmations: 0,
          requiredConfirmations: payment.requiredConfirmations,
          canonical: true,
          complianceClear: true,
          qualifyingEventClaimed: true,
        });
        if (!evaluation.legal) {
          throw new ClaimRoutingAbortedError("payment_changed_concurrently");
        }
        const updated = await this.#models.Payment.findOneAndUpdate(
          { paymentId, status: "pending", version: payment.version },
          {
            $set: {
              status: "matched",
              matchedEventId: event.eventId,
              transactionHash: event.transactionHash,
              amountReceived: baseUnit(cumulative),
              partialAmountReceived: baseUnit(cumulative),
              overpaymentFlag: excess > 0n,
              underpaymentFlag: false,
              matchedAt: now,
              ...(excess === 0n ? {} : { excessAmount: baseUnit(excess) }),
            },
            $inc: { version: 1 },
          },
          { session },
        );
        if (updated === null) {
          throw new ClaimRoutingAbortedError("payment_changed_concurrently");
        }
        await appendAuditEntryInTransaction(
          this.#connection,
          {
            scope: `merchant_${payment.merchantId}`,
            entityType: "Payment",
            entityId: paymentId,
            action: "payment_matched",
            actorType: "system",
            actorId: "processor",
            before: { status: "pending" },
            after: {
              status: "matched",
              amountReceived: baseUnit(cumulative),
              ...(excess === 0n ? {} : { excessAmount: baseUnit(excess) }),
              eventId: event.eventId,
            },
            eventId: event.eventId,
            transactionHash: event.transactionHash,
          },
          session,
        );
        let matchedDeliveryId: string | undefined;
        if (this.#outbox !== undefined) {
          matchedDeliveryId = await this.#outbox.writeInTransaction(
            session,
            WebhookOutboxWriter.payloadFor(
              {
                ...payment,
                status: "matched",
                amountReceived: baseUnit(cumulative),
                partialAmountReceived: baseUnit(cumulative),
                ...(excess === 0n ? {} : { excessAmount: baseUnit(excess) }),
                transactionHash: event.transactionHash,
              },
              "payment.matched",
              now,
            ),
          );
        }
        return {
          eventId: event.eventId,
          action: "claimed_matched",
          paymentId,
          ...(matchedDeliveryId === undefined
            ? {}
            : { deliveryIds: [matchedDeliveryId] }),
          ...(excess === 0n
            ? {}
            : {
                postTransaction: () =>
                  this.#annotate(
                    "Payment",
                    paymentId,
                    "excess",
                    `Overpayment excess ${baseUnit(excess)} base units recorded for reconciliation`,
                    payment.merchantId,
                  ),
              }),
        };
      }

      // matched or confirming: replacement re-link or excess top-up.
      return this.#linkInTransaction(session, event, payment, cumulative, excess);
    });
  }

  async #expireInTransaction(
    session: ClientSession,
    event: EventDocument,
    payment: PaymentDocument,
    now: Date,
  ): Promise<ClaimOutcome> {
    const claims = await this.#models.OnChainEvent.find({
      matchedPaymentId: payment.paymentId,
      canonical: true,
    })
      .session(session)
      .lean();
    const total = claims.reduce(
      (sum, claim) => sum + effectiveAmount(claim as unknown as EventDocument),
      0n,
    );
    const qualifying = total >= BigInt(payment.amount);
    let expiredDeliveryId: string | undefined;
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
      qualifyingEventClaimed: qualifying,
    });
    if (evaluation.legal) {
      const updated = await this.#models.Payment.findOneAndUpdate(
        { paymentId: payment.paymentId, status: "pending", version: payment.version },
        {
          $set: {
            status: "expired",
            terminalAt: now,
            partialAmountReceived: baseUnit(total),
            underpaymentFlag: total > 0n && total < BigInt(payment.amount),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (updated === null) {
        throw new ClaimRoutingAbortedError("payment_changed_concurrently");
      }
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: `merchant_${payment.merchantId}`,
          entityType: "Payment",
          entityId: payment.paymentId,
          action: "payment_expired",
          actorType: "system",
          actorId: "processor",
          before: { status: "pending" },
          after: { status: "expired", partialAmountReceived: baseUnit(total) },
          eventId: event.eventId,
          transactionHash: event.transactionHash,
        },
        session,
      );
      if (this.#outbox !== undefined) {
        expiredDeliveryId = await this.#outbox.writeInTransaction(
          session,
          WebhookOutboxWriter.payloadFor(
            {
              ...payment,
              status: "expired",
              partialAmountReceived: baseUnit(total),
            },
            "payment.expired",
            now,
          ),
        );
      }
    }
    return {
      eventId: event.eventId,
      action: "late_arrival_annotated",
      paymentId: payment.paymentId,
      ...(expiredDeliveryId === undefined ? {} : { deliveryIds: [expiredDeliveryId] }),
      postTransaction: async () => {
        if (total > 0n && total < BigInt(payment.amount)) {
          await this.#annotate(
            "Payment",
            payment.paymentId,
            "partial",
            "Expired with partial transfers; held for manual refund/reconciliation review",
            payment.merchantId,
          );
        }
        await this.#annotate(
          "OnChainEvent",
          event.eventId,
          "late",
          "Qualifying deposit arrived after payment expiry; routed to manual reconciliation",
          payment.merchantId,
        );
      },
    };
  }

  /**
   * A canonical qualifying event arrived while the payment is already
   * matched or confirming: either a replacement after a reorg orphaned the
   * previous matching event, or an additional transfer that only grows the
   * received and excess totals. The status never changes here.
   */
  async #linkInTransaction(
    session: ClientSession,
    event: EventDocument,
    payment: PaymentDocument,
    cumulative: bigint,
    excess: bigint,
  ): Promise<ClaimOutcome> {
    let replacement = false;
    if (payment.matchedEventId !== undefined) {
      const previous = await this.#models.OnChainEvent.findOne({
        eventId: payment.matchedEventId,
      })
        .session(session)
        .lean();
      replacement =
        previous === null || !(previous as unknown as EventDocument).canonical;
    }
    const updated = await this.#models.Payment.findOneAndUpdate(
      {
        paymentId: payment.paymentId,
        status: { $in: ["matched", "confirming"] },
        version: payment.version,
      },
      {
        $set: {
          amountReceived: baseUnit(cumulative),
          partialAmountReceived: baseUnit(cumulative),
          overpaymentFlag: excess > 0n,
          ...(excess === 0n ? {} : { excessAmount: baseUnit(excess) }),
          ...(replacement
            ? {
                matchedEventId: event.eventId,
                transactionHash: event.transactionHash,
                confirmations: 0,
              }
            : {}),
        },
        $inc: { version: 1 },
      },
      { session },
    );
    if (updated === null) {
      throw new ClaimRoutingAbortedError("payment_changed_concurrently");
    }
    await appendAuditEntryInTransaction(
      this.#connection,
      {
        scope: `merchant_${payment.merchantId}`,
        entityType: "Payment",
        entityId: payment.paymentId,
        action: replacement ? "payment_replacement_linked" : "payment_excess_linked",
        actorType: "system",
        actorId: "processor",
        before: { status: payment.status, matchedEventId: payment.matchedEventId },
        after: {
          status: payment.status,
          matchedEventId: replacement ? event.eventId : payment.matchedEventId,
          amountReceived: baseUnit(cumulative),
          eventId: event.eventId,
        },
        eventId: event.eventId,
        transactionHash: event.transactionHash,
      },
      session,
    );

    if (replacement) {
      return {
        eventId: event.eventId,
        action: "replacement_linked",
        paymentId: payment.paymentId,
      };
    }
    if (excess > 0n) {
      return {
        eventId: event.eventId,
        action: "excess_linked",
        paymentId: payment.paymentId,
        postTransaction: () =>
          this.#annotate(
            "Payment",
            payment.paymentId,
            "excess",
            `Additional overpayment excess ${baseUnit(excess)} base units recorded`,
            payment.merchantId,
          ),
      };
    }
    return {
      eventId: event.eventId,
      action: "excess_linked",
      paymentId: payment.paymentId,
    };
  }

  /**
   * Cumulative canonical claimed total for the payment inside the session,
   * including this event now that it is claimed. Recomputed from the durable
   * claim set — never an increment — so orphaned partials fall out of the
   * total automatically during reorg resolution.
   */
  async #cumulativeIncluding(
    event: EventDocument,
    paymentId: string,
    session: ClientSession,
  ): Promise<bigint> {
    const claims = await this.#models.OnChainEvent.find({
      matchedPaymentId: paymentId,
      canonical: true,
    })
      .session(session)
      .lean();
    let total = 0n;
    let includesEvent = false;
    for (const claim of claims) {
      const typed = claim as unknown as EventDocument;
      if (typed.eventId === event.eventId) includesEvent = true;
      total += effectiveAmount(typed);
    }
    if (!includesEvent) total += effectiveAmount(event);
    return total;
  }

  /**
   * Conditionally claim the event for the payment inside the caller's
   * transaction. A conditional update (never an unconditional set) avoids
   * duplicate-key aborts: when another payment owns the claim the filter
   * matches nothing and the loser is resolved by re-reading the owner.
   */
  async #claimEvent(
    eventId: string,
    paymentId: string,
    session: ClientSession,
  ): Promise<boolean> {
    const claimed = await this.#models.OnChainEvent.findOneAndUpdate(
      { eventId, matchedPaymentId: { $exists: false } },
      { $set: { matchedPaymentId: paymentId } },
      { session },
    );
    if (claimed !== null) return true;
    const existing = await this.#models.OnChainEvent.findOne({ eventId })
      .session(session)
      .lean();
    const owner = (existing as unknown as EventDocument | null)?.matchedPaymentId;
    return owner === paymentId;
  }

  async #handleAbortedClaim(
    event: EventDocument,
    payment: PaymentDocument,
    reason: "payment_changed_concurrently" | "payment_terminal" | "tolerance_exceeded",
    logger: Logger,
  ): Promise<void> {
    logger.debug(
      { paymentId: payment.paymentId, eventId: event.eventId, reason },
      "Claim routing aborted; the concurrent winner's outcome stands",
    );
    if (reason === "tolerance_exceeded") {
      await this.#annotate(
        "OnChainEvent",
        event.eventId,
        "excess",
        "Over-amount deposit left unclaimed: overpayment tolerance is disabled",
        payment.merchantId,
      );
      return;
    }
    await appendAuditEntry(this.#connection, {
      scope: `merchant_${payment.merchantId}`,
      entityType: "Payment",
      entityId: payment.paymentId,
      action: "payment_transition_rejected",
      actorType: "system",
      actorId: "processor",
      before: { status: payment.status },
      after: { status: payment.status, attempted: payment.status },
      eventId: event.eventId,
      transactionHash: event.transactionHash,
      metadata: { reason },
    });
  }

  async #annotate(
    entityType: "Payment" | "OnChainEvent",
    entityId: string,
    category: "orphan" | "late" | "partial" | "excess" | "reorg" | "compliance",
    note: string,
    merchantId?: string,
  ): Promise<void> {
    const annotationId = annotationIdFor(entityType, entityId, category);
    try {
      await this.#models.ReconciliationAnnotation.create({
        annotationId,
        entityType,
        entityId,
        ...(merchantId === undefined ? {} : { merchantId }),
        category,
        status: "open",
        note,
        createdBy: "processor",
        createdAt: new Date(),
      });
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) return;
      throw error;
    }
  }
}
