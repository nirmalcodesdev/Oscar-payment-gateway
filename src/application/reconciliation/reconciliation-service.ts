import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { AdminPrincipal } from "../auth/principals.js";
import type { WebhookDispatcher } from "../webhooks/webhook-outbox.js";
import { appendAuditEntry } from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";

export interface ReconciliationOrphanEvent {
  readonly eventId: string;
  readonly chain: string;
  readonly amount: string;
  readonly toAddress: string;
  readonly blockNumber: number;
  readonly ingestedAt: Date;
}

export interface ReconciliationStalePayment {
  readonly paymentId: string;
  readonly merchantId: string;
  readonly status: string;
  readonly amount: string;
  readonly staleSince: Date;
}

export interface ReconciliationWebhookEntry {
  readonly deliveryId: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly eventType: string;
  readonly attempts: number;
  readonly lastResponseCode?: number;
}

export interface ReconciliationOverview {
  readonly orphanEvents: readonly ReconciliationOrphanEvent[];
  readonly openAnnotations: readonly {
    readonly annotationId: string;
    readonly category: string;
    readonly entityId: string;
    readonly status: string;
    readonly createdAt: Date;
  }[];
  readonly stalePayments: readonly ReconciliationStalePayment[];
  readonly complianceHolds: readonly {
    readonly paymentId: string;
    readonly merchantId: string;
    readonly screeningStatus: string;
    readonly status: string;
  }[];
  readonly reorgEffects: readonly {
    readonly paymentId: string;
    readonly merchantId: string;
    readonly automationHold: boolean;
    readonly status: string;
  }[];
  readonly webhookDeadLetter: readonly ReconciliationWebhookEntry[];
}

export class ReconciliationControlError extends Error {
  public constructor(
    public readonly code: "NOT_FOUND" | "CONFLICT",
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ReconciliationControlError";
  }
}

/**
 * Admin reconciliation views and decisions (ADR 0015). Views surface —
 * never hide — discrepancies; every decision writes an audit entry, and the
 * audit log itself stays read-only through every application API.
 */
export class ReconciliationService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #webhooks: WebhookDispatcher | undefined;
  readonly #logger: Logger;

  public constructor(
    connection: Connection,
    logger: Logger,
    webhooks?: WebhookDispatcher,
  ) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#webhooks = webhooks;
    this.#logger = logger.child({ component: "reconciliation" });
  }

  public async overview(limit = 50): Promise<ReconciliationOverview> {
    const orphanGrace = new Date(Date.now() - 15 * 60_000);
    const staleThreshold = new Date(Date.now() - 30 * 60_000);

    const orphanDocs = await this.#models.OnChainEvent.find({
      interpretationStatus: "accepted",
      canonical: true,
      matchedPaymentId: { $exists: false },
      ingestedAt: { $lt: orphanGrace },
    })
      .sort({ ingestedAt: 1 })
      .limit(limit)
      .lean();

    const annotations = await this.#models.ReconciliationAnnotation.find({
      status: "open",
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    const staleDocs = await this.#models.Payment.find({
      status: { $in: ["matched", "confirming"] },
      updatedAt: { $lt: staleThreshold },
    })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();

    const holdDocs = await this.#models.Payment.find({
      status: { $in: ["pending", "matched", "confirming"] },
      screeningStatus: { $in: ["flagged", "blocked"] },
    })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();

    const reorgDocs = await this.#models.Payment.find({
      $or: [{ automationHold: true }, { status: { $in: ["matched", "confirming"] } }],
      updatedAt: { $lt: staleThreshold },
    })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();

    const deadLetter = await this.#models.WebhookDelivery.find({
      status: "dead_letter",
    })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();

    return {
      orphanEvents: orphanDocs.map((doc) => ({
        eventId: doc.eventId,
        chain: doc.chain,
        amount: doc.amount,
        toAddress: doc.normalizedToAddress,
        blockNumber: doc.blockNumber,
        ingestedAt: doc.ingestedAt,
      })),
      openAnnotations: annotations.map((doc) => ({
        annotationId: doc.annotationId,
        category: doc.category,
        entityId: doc.entityId,
        status: doc.status,
        createdAt: doc.createdAt,
      })),
      stalePayments: staleDocs.map((doc) => ({
        paymentId: doc.paymentId,
        merchantId: doc.merchantId,
        status: doc.status,
        amount: doc.amount,
        staleSince: (doc as { updatedAt?: Date }).updatedAt ?? new Date(0),
      })),
      complianceHolds: holdDocs.map((doc) => ({
        paymentId: doc.paymentId,
        merchantId: doc.merchantId,
        screeningStatus: doc.screeningStatus,
        status: doc.status,
      })),
      reorgEffects: reorgDocs
        .filter(
          (doc) =>
            doc.automationHold ||
            (doc.status !== "matched" && doc.status !== "confirming"),
        )
        .map((doc) => ({
          paymentId: doc.paymentId,
          merchantId: doc.merchantId,
          automationHold: doc.automationHold,
          status: doc.status,
        })),
      webhookDeadLetter: deadLetter.map((doc) => ({
        deliveryId: doc.deliveryId,
        merchantId: doc.merchantId,
        paymentId: doc.paymentId,
        eventType: doc.eventType,
        attempts: doc.attempts,
        ...(doc.lastResponseCode == null
          ? {}
          : { lastResponseCode: doc.lastResponseCode }),
      })),
    };
  }

  /** Resolve an open annotation with a required note, audited. */
  public async resolveAnnotation(
    principal: AdminPrincipal,
    annotationId: string,
    note: string,
  ): Promise<void> {
    const annotation = await this.#models.ReconciliationAnnotation.findOne({
      annotationId,
    }).lean();
    if (annotation === null) {
      throw new ReconciliationControlError("NOT_FOUND", "Annotation not found", 404);
    }
    if (annotation.status !== "open") {
      throw new ReconciliationControlError(
        "CONFLICT",
        "Annotation is already resolved",
        409,
      );
    }
    const resolvedAt = new Date();
    const updated = await this.#models.ReconciliationAnnotation.updateOne(
      { annotationId, status: "open" },
      { $set: { status: "resolved", resolvedBy: principal.adminId, resolvedAt } },
    );
    if (updated.modifiedCount !== 1) {
      throw new ReconciliationControlError(
        "CONFLICT",
        "Annotation is already resolved",
        409,
      );
    }
    await appendAuditEntry(this.#connection, {
      scope: `admin_reconciliation_${annotation.entityId}`,
      entityType: "ReconciliationAnnotation",
      entityId: annotationId,
      action: "reconciliation_annotation_resolved",
      actorType: "admin",
      actorId: principal.adminId,
      before: { status: "open", category: annotation.category },
      after: { status: "resolved" },
      metadata: { note, category: annotation.category },
    });
  }

  /** Replay a dead-lettered or stuck webhook delivery, audited. */
  public async replayWebhook(
    principal: AdminPrincipal,
    deliveryId: string,
  ): Promise<{ readonly status: string }> {
    if (this.#webhooks === undefined) {
      throw new ReconciliationControlError(
        "CONFLICT",
        "Webhook dispatch is not available",
        503,
      );
    }
    const delivery = await this.#models.WebhookDelivery.findOne({ deliveryId }).lean();
    if (delivery === null) {
      throw new ReconciliationControlError("NOT_FOUND", "Delivery not found", 404);
    }
    if (delivery.status === "delivered") {
      throw new ReconciliationControlError(
        "CONFLICT",
        "Delivery already succeeded",
        409,
      );
    }
    const resetAt = new Date();
    const updated = await this.#models.WebhookDelivery.updateOne(
      { deliveryId, status: { $ne: "delivered" } },
      { $set: { status: "pending", nextAttemptAt: resetAt } },
    );
    if (updated.modifiedCount !== 1) {
      throw new ReconciliationControlError(
        "CONFLICT",
        "Delivery already succeeded",
        409,
      );
    }
    await appendAuditEntry(this.#connection, {
      scope: `merchant_${delivery.merchantId}`,
      entityType: "WebhookDelivery",
      entityId: deliveryId,
      action: "webhook_replay_requested",
      actorType: "admin",
      actorId: principal.adminId,
      before: { status: delivery.status, attempts: delivery.attempts },
      after: { status: "pending", replayedAt: resetAt.toISOString() },
      metadata: { paymentId: delivery.paymentId, eventType: delivery.eventType },
    });
    await this.#webhooks.enqueueWebhookDelivery(deliveryId);
    this.#logger.info(
      { deliveryId, adminId: principal.adminId },
      "Webhook replay enqueued",
    );
    return { status: "pending" };
  }
}
