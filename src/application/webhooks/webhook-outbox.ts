import { randomUUID } from "node:crypto";

import type { ClientSession, Connection } from "mongoose";

import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";

export type WebhookEventType =
  | "payment.matched"
  | "payment.confirmed"
  | "payment.expired"
  | "payment.failed";

/** Post-commit enqueue port implemented by the BullMQ delivery queue. */
export interface WebhookDispatcher {
  enqueueWebhookDelivery(deliveryId: string): Promise<void>;
}

export interface WebhookPayload {
  readonly paymentId: string;
  readonly merchantId: string;
  readonly eventType: WebhookEventType;
  readonly status: string;
  readonly paymentVersion: number;
  readonly chain: string;
  readonly token: string;
  readonly amount: string;
  readonly amountReceived?: string;
  readonly excessAmount?: string;
  readonly partialAmountReceived?: string;
  readonly transactionHash?: string;
  readonly occurredAt: string;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === 11_000
  );
}

/**
 * Transactional webhook outbox (ADR 0014). Rows are written inside the same
 * replica-set transaction as the payment transition and its audit entry, so
 * a committed transition always has its notification and a rollback sends
 * nothing. The unique `idempotencyKey` — one per
 * `(paymentId, eventType, paymentVersion)` — collapses duplicate writes by
 * competing workers or replays into exactly one durable row.
 */
export class WebhookOutboxWriter {
  readonly #models: ReturnType<typeof registerPersistenceModels>;

  public constructor(connection: Connection) {
    this.#models = registerPersistenceModels(connection);
  }

  public idempotencyKey(
    paymentId: string,
    eventType: WebhookEventType,
    paymentVersion: number,
  ): string {
    return `wh_${paymentId}_${eventType.replace(/\./g, ":")}_v${paymentVersion}`;
  }

  /**
   * Write the outbox row on the caller's transaction session. Duplicate-key
   * collapses are benign: the winner's row is the durable notification.
   */
  public async writeInTransaction(
    session: ClientSession,
    payload: WebhookPayload,
  ): Promise<string | undefined> {
    const idempotencyKey = this.idempotencyKey(
      payload.paymentId,
      payload.eventType,
      payload.paymentVersion,
    );
    const deliveryId = `delivery_${randomUUID()}`;
    try {
      await this.#models.WebhookDelivery.create(
        [
          {
            deliveryId,
            merchantId: payload.merchantId,
            paymentId: payload.paymentId,
            eventType: payload.eventType,
            idempotencyKey,
            payload,
            status: "pending",
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        ],
        { session, ordered: true },
      );
      return deliveryId;
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) return undefined;
      throw error;
    }
  }

  /** Build the merchant-facing payload snapshot for a payment transition. */
  public static payloadFor(
    payment: {
      readonly paymentId: string;
      readonly merchantId: string;
      readonly status: string;
      readonly version: number;
      readonly chain: string;
      readonly token: string;
      readonly amount: string;
      readonly amountReceived?: string | undefined;
      readonly excessAmount?: string | undefined;
      readonly partialAmountReceived?: string | undefined;
      readonly transactionHash?: string | undefined;
    },
    eventType: WebhookEventType,
    occurredAt: Date,
  ): WebhookPayload {
    return {
      paymentId: payment.paymentId,
      merchantId: payment.merchantId,
      eventType,
      status: payment.status,
      paymentVersion: payment.version,
      chain: payment.chain,
      token: payment.token,
      amount: payment.amount,
      ...(payment.amountReceived === undefined
        ? {}
        : { amountReceived: payment.amountReceived }),
      ...(payment.excessAmount === undefined
        ? {}
        : { excessAmount: payment.excessAmount }),
      ...(payment.partialAmountReceived === undefined
        ? {}
        : { partialAmountReceived: payment.partialAmountReceived }),
      ...(payment.transactionHash === undefined
        ? {}
        : { transactionHash: payment.transactionHash }),
      occurredAt: occurredAt.toISOString(),
    };
  }
}
