import { createHash } from "node:crypto";

import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import type { SanctionsScreeningProvider } from "../../domain/compliance/screening-provider.js";
import { screeningStatusForVerdict } from "../../domain/compliance/screening-provider.js";
import {
  evaluatePaymentTransition,
  type PaymentStatus,
} from "../../domain/payments/payment-state-machine.js";
import {
  WebhookOutboxWriter,
  type WebhookDispatcher,
} from "../webhooks/webhook-outbox.js";
import { appendAuditEntryInTransaction } from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { withRequiredTransaction } from "../../infrastructure/mongodb/transactions.js";

/** Corroborated chain observation of a payment's matching transaction. */
export interface ConfirmationObservation {
  readonly status: "observed" | "unavailable";
  readonly confirmations?: number;
  readonly canonical?: boolean;
}

/**
 * Read-only confirmation port (ADR 0012). Implementations corroborate the
 * transaction's block hash and depth through independent providers and fail
 * closed (`unavailable`) on disagreement.
 */
export interface PaymentConfirmationReader {
  observe(event: {
    readonly chain: string;
    readonly transactionHash: string;
    readonly blockNumber: number;
    readonly blockHash: string;
  }): Promise<ConfirmationObservation>;
}

export type ConfirmationAdvance =
  | { readonly outcome: "terminal"; readonly status: PaymentStatus }
  | { readonly outcome: "progressed"; readonly status: PaymentStatus }
  | { readonly outcome: "waiting" }
  | { readonly outcome: "held" }
  | { readonly outcome: "automation_hold" };

interface EventDocument {
  readonly eventId: string;
  readonly chain: string;
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly fromAddress: string;
  readonly normalizedFromAddress: string;
  readonly canonical: boolean;
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
  readonly confirmations: number;
  readonly expiresAt: Date;
  readonly matchedEventId?: string;
  readonly screeningStatus: string;
  readonly automationHold?: boolean;
  readonly transactionHash?: string;
  readonly amountReceived?: string;
}

/**
 * Drives `matched → confirming → confirmed` (ADR 0012). One invocation is
 * one state-machine step; the deterministic queue job re-enqueues itself
 * while the payment waits for depth, canonicality, or screening. Every
 * applied or rejected transition leaves an append-only audit entry.
 */
export class PaymentConfirmationService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #config: RuntimeConfig;
  readonly #reader: PaymentConfirmationReader;
  readonly #screening: SanctionsScreeningProvider;
  readonly #latestReviewDecision:
    | ((paymentId: string) => Promise<"release" | "block" | undefined>)
    | undefined;
  readonly #outbox: WebhookOutboxWriter | undefined;
  readonly #dispatcher: WebhookDispatcher | undefined;

  public constructor(
    connection: Connection,
    config: RuntimeConfig,
    dependencies: {
      readonly reader: PaymentConfirmationReader;
      readonly screening: SanctionsScreeningProvider;
      readonly latestReviewDecision?: (
        paymentId: string,
      ) => Promise<"release" | "block" | undefined>;
      readonly webhookDispatcher?: WebhookDispatcher;
    },
  ) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#config = config;
    this.#reader = dependencies.reader;
    this.#screening = dependencies.screening;
    this.#latestReviewDecision = dependencies.latestReviewDecision;
    this.#outbox =
      dependencies.webhookDispatcher === undefined
        ? undefined
        : new WebhookOutboxWriter(connection);
    this.#dispatcher = dependencies.webhookDispatcher;
  }

  public async advancePayment(
    paymentId: string,
    logger: Logger,
  ): Promise<ConfirmationAdvance> {
    const raw = await this.#models.Payment.findOne({ paymentId }).lean();
    if (raw === null) {
      throw new Error(`Payment ${paymentId} was not found`);
    }
    const payment = raw as unknown as PaymentDocument;

    if (payment.automationHold === true) {
      return { outcome: "automation_hold" };
    }
    if (
      payment.status === "confirmed" ||
      payment.status === "expired" ||
      payment.status === "failed"
    ) {
      return { outcome: "terminal", status: payment.status as PaymentStatus };
    }
    if (payment.status !== "matched" && payment.status !== "confirming") {
      return { outcome: "waiting" };
    }
    if (payment.matchedEventId === undefined) {
      logger.error({ paymentId }, "Matched payment has no matching event");
      return { outcome: "waiting" };
    }

    const eventRaw = await this.#models.OnChainEvent.findOne({
      eventId: payment.matchedEventId,
    }).lean();
    if (eventRaw === null) {
      logger.error(
        { paymentId, eventId: payment.matchedEventId },
        "Matching event disappeared; leaving payment for reconciliation",
      );
      return { outcome: "waiting" };
    }
    const event = eventRaw as unknown as EventDocument;

    const observation = await this.#reader.observe({
      chain: event.chain,
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
    });
    if (observation.status === "unavailable") {
      // Fail closed: no state change without a corroborated observation.
      logger.warn({ paymentId }, "Confirmation observation unavailable");
      return { outcome: "waiting" };
    }

    const canonical = observation.canonical === true && event.canonical;
    const confirmations = observation.confirmations ?? 0;
    const now = new Date();

    // Reorg path: the matching transaction is gone and the replacement
    // grace has elapsed, so the legal off-ramp is `failed`.
    if (!canonical) {
      const evaluation = evaluatePaymentTransition({
        from: payment.status as PaymentStatus,
        to: "failed",
        now,
        expiresAt: payment.expiresAt,
        reorgGraceMs: this.#config.processing.latePaymentGraceSec * 1000,
        confirmations,
        requiredConfirmations: payment.requiredConfirmations,
        canonical,
        complianceClear: false,
        qualifyingEventClaimed: true,
      });
      if (evaluation.legal) {
        await this.#applyTransition(
          payment,
          "failed",
          { terminalAt: now },
          event,
          logger,
        );
        await this.#annotate(
          "Payment",
          payment.paymentId,
          "reorg",
          "Matching transaction removed by a reorg with no replacement before the grace deadline",
          payment.merchantId,
        );
        return { outcome: "terminal", status: "failed" };
      }
      return { outcome: "waiting" };
    }

    if (payment.status === "matched") {
      const evaluation = evaluatePaymentTransition({
        from: "matched",
        to: "confirming",
        now,
        expiresAt: payment.expiresAt,
        reorgGraceMs: this.#config.processing.latePaymentGraceSec * 1000,
        confirmations,
        requiredConfirmations: payment.requiredConfirmations,
        canonical,
        complianceClear: true,
        qualifyingEventClaimed: true,
      });
      if (!evaluation.legal) {
        await this.#recordRejection(
          payment,
          "matched",
          "confirming",
          evaluation.reason,
          event,
        );
        return { outcome: "waiting" };
      }
      await this.#applyTransition(
        payment,
        "confirming",
        { confirmations: 0 },
        event,
        logger,
      );
      return { outcome: "progressed", status: "confirming" };
    }

    // confirming
    const capped = Math.min(confirmations, payment.requiredConfirmations);
    if (capped < payment.requiredConfirmations) {
      if (capped > payment.confirmations) {
        const evaluation = evaluatePaymentTransition({
          from: "confirming",
          to: "confirming",
          now,
          expiresAt: payment.expiresAt,
          reorgGraceMs: this.#config.processing.latePaymentGraceSec * 1000,
          confirmations: capped,
          requiredConfirmations: payment.requiredConfirmations,
          canonical,
          complianceClear: true,
          qualifyingEventClaimed: true,
        });
        if (evaluation.legal) {
          await this.#applyTransition(
            payment,
            "confirming",
            { confirmations: capped },
            event,
            logger,
          );
          return { outcome: "progressed", status: "confirming" };
        }
        await this.#recordRejection(
          payment,
          "confirming",
          "confirming",
          evaluation.reason,
          event,
        );
      }
      return { outcome: "waiting" };
    }

    // Threshold reached: fresh compliance check of the event sender gates
    // the terminal confirmation (fail closed on any non-clear verdict).
    // Record-keeping and caching live in the screening facade (ADR 0013).
    const decision =
      (await this.#latestReviewDecision?.(payment.paymentId)) ?? undefined;
    if (decision === "block") {
      // An authorized block decision pins the hold regardless of any later
      // clear screen (ADR 0013): only a newer decision can unpin it.
      await this.#annotate(
        "Payment",
        payment.paymentId,
        "compliance",
        "Blocked by an authorized compliance review decision",
        payment.merchantId,
      );
      return { outcome: "held" };
    }

    const screening = await this.#screening.screen({
      address: event.fromAddress,
      chain: event.chain,
    });
    const screeningStatus = screeningStatusForVerdict(screening.verdict);
    const now2 = new Date();

    if (screeningStatus !== "clear") {
      if (decision !== "release") {
        // Compliance hold: the payment can never reach `confirmed` and can
        // never emit a confirmation webhook while held (ADR 0011). Only an
        // authorized audited release decision can override (ADR 0013).
        if (payment.screeningStatus !== screeningStatus) {
          await this.#applyTransition(
            payment,
            payment.status as PaymentStatus,
            { screeningStatus },
            event,
            logger,
            "payment_compliance_hold",
          );
        }
        await this.#annotate(
          "Payment",
          payment.paymentId,
          "compliance",
          `Sender screening verdict ${screening.verdict} holds confirmation for manual review`,
          payment.merchantId,
        );
        return { outcome: "held" };
      }
      // Cleared with an authorized override; the confirmation audit records
      // the override provenance below.
      await this.#applyTransition(
        payment,
        payment.status as PaymentStatus,
        { screeningStatus: "clear" },
        event,
        logger,
        "payment_compliance_override_released",
      );
    }

    const evaluation = evaluatePaymentTransition({
      from: "confirming",
      to: "confirmed",
      now: now2,
      expiresAt: payment.expiresAt,
      reorgGraceMs: this.#config.processing.latePaymentGraceSec * 1000,
      confirmations: capped,
      requiredConfirmations: payment.requiredConfirmations,
      canonical,
      complianceClear: true,
      qualifyingEventClaimed: true,
    });
    if (!evaluation.legal) {
      await this.#recordRejection(
        payment,
        "confirming",
        "confirmed",
        evaluation.reason,
        event,
      );
      return { outcome: "waiting" };
    }
    await this.#applyTransition(
      payment,
      "confirmed",
      {
        confirmations: payment.requiredConfirmations,
        screeningStatus: "clear",
        confirmedAt: now2,
        terminalAt: now2,
      },
      event,
      logger,
    );
    return { outcome: "terminal", status: "confirmed" };
  }

  async #applyTransition(
    payment: PaymentDocument,
    to: PaymentStatus,
    setFields: Readonly<Record<string, unknown>>,
    event: EventDocument,
    logger: Logger,
    action = `payment_${to}`,
  ): Promise<boolean> {
    const from = payment.status as PaymentStatus;
    // Only merchant-facing terminal transitions emit webhooks (ADR 0014);
    // internal hold representations never notify.
    const emitsWebhook = to === "confirmed" || to === "failed";
    let deliveryId: string | undefined;
    const applied = await withRequiredTransaction(
      this.#connection,
      async (session): Promise<boolean> => {
        const updated = await this.#models.Payment.findOneAndUpdate(
          {
            paymentId: payment.paymentId,
            status: payment.status,
            version: payment.version,
          },
          { $set: { status: to, ...setFields }, $inc: { version: 1 } },
          { session },
        );
        await appendAuditEntryInTransaction(
          this.#connection,
          {
            scope: `merchant_${payment.merchantId}`,
            entityType: "Payment",
            entityId: payment.paymentId,
            action,
            actorType: "system",
            actorId: "processor",
            before: { status: from, confirmations: payment.confirmations },
            after: {
              status: to,
              confirmations: setFields["confirmations"] ?? payment.confirmations,
            },
            eventId: event.eventId,
            transactionHash: event.transactionHash,
          },
          session,
        );
        if (updated !== null && emitsWebhook && this.#outbox !== undefined) {
          const amountReceived = setFields["amountReceived"];
          const transactionHash = setFields["transactionHash"];
          deliveryId = await this.#outbox.writeInTransaction(
            session,
            WebhookOutboxWriter.payloadFor(
              {
                ...payment,
                status: to,
                ...(typeof amountReceived === "string" ? { amountReceived } : {}),
                ...(typeof transactionHash === "string" ? { transactionHash } : {}),
              },
              to === "confirmed" ? "payment.confirmed" : "payment.failed",
              new Date(),
            ),
          );
        }
        return updated !== null;
      },
    );
    if (!applied) {
      logger.debug(
        { paymentId: payment.paymentId, from, to },
        "Stale confirmation transition collapsed to an auditable no-op",
      );
      return false;
    }
    if (deliveryId !== undefined && this.#dispatcher !== undefined) {
      await this.#dispatcher.enqueueWebhookDelivery(deliveryId);
    }
    return true;
  }

  async #recordRejection(
    payment: PaymentDocument,
    from: PaymentStatus,
    to: PaymentStatus,
    reason: string,
    event: EventDocument,
  ): Promise<void> {
    await withRequiredTransaction(this.#connection, (session) =>
      appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: `merchant_${payment.merchantId}`,
          entityType: "Payment",
          entityId: payment.paymentId,
          action: "payment_transition_rejected",
          actorType: "system",
          actorId: "processor",
          before: { status: from },
          after: { status: from, attempted: to },
          eventId: event.eventId,
          transactionHash: event.transactionHash,
          metadata: { reason },
        },
        session,
      ),
    );
  }

  async #annotate(
    entityType: "Payment",
    entityId: string,
    category: "reorg" | "compliance",
    note: string,
    merchantId?: string,
  ): Promise<void> {
    const digest = createHash("sha256")
      .update(`${entityType}:${entityId}:${category}`)
      .digest("hex");
    const annotationId = `ann_${digest.slice(0, 40)}`;
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
      if (
        typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "code") === 11_000
      ) {
        return;
      }
      throw error;
    }
  }
}
