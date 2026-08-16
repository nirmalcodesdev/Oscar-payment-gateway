import { Queue, Worker, type Job, type Processor } from "bullmq";
import type { Connection } from "mongoose";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import { registerPersistenceModels } from "../mongodb/models.js";
import type { ManagedResource } from "../lifecycle/managed-resource.js";
import { signedWebhookHeaders } from "../auth/webhook-signer.js";
import {
  generateTraceContext,
  traceParentHeader,
} from "../observability/trace-context.js";
import { WebhookDeliveryClient, WebhookDeliveryError } from "../http/webhook-client.js";
import { validateWebhookUrl } from "../../domain/security/webhook-url.js";
import type { WebhookDispatcher } from "../../application/webhooks/webhook-outbox.js";

export const webhookDeliveryQueueName = "webhook-delivery";

export interface WebhookDeliveryJobData {
  readonly deliveryId: string;
}

export const webhookBackoffBaseMs = 2_000;
export const webhookBackoffCapMs = 300_000;
export const webhookJitterCapMs = 1_000;

export function webhookBackoffDelayMs(attemptsMade: number): number {
  const base = webhookBackoffBaseMs * 2 ** Math.max(0, attemptsMade - 1);
  const capped = Math.min(base, webhookBackoffCapMs);
  return capped + Math.floor(Math.random() * Math.min(capped, webhookJitterCapMs));
}

/** Deterministic byte-stable serialization so every retry signs the same body. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Durable webhook delivery (ADR 0014). BullMQ owns retry timing with
  jittered exponential backoff and bounded attempts; the outbox row records
 * per-attempt observability and is marked `dead_letter` when attempts are
 * exhausted. `jobId = deliveryId` collapses duplicate enqueues; the
 * scheduler sweep re-enqueues rows whose enqueue was lost to a crash.
 */
export class WebhookDeliveryQueue implements WebhookDispatcher {
  readonly #queue: Queue<WebhookDeliveryJobData, unknown>;

  public constructor(
    redis: Redis,
    queuePrefix: string,
    private readonly maxAttempts: number,
  ) {
    this.#queue = new Queue<WebhookDeliveryJobData, unknown, string>(
      webhookDeliveryQueueName,
      {
        prefix: queuePrefix,
        connection: redis,
        defaultJobOptions: {
          attempts: maxAttempts,
          backoff: { type: "custom", delay: webhookBackoffBaseMs },
          removeOnComplete: true,
          removeOnFail: false,
        },
      },
    );
  }

  public async enqueueWebhookDelivery(deliveryId: string): Promise<void> {
    await this.#queue.add("deliver", { deliveryId }, { jobId: deliveryId });
  }

  public async close(): Promise<void> {
    await this.#queue.close();
  }
}

export class WebhookDeliveryWorkerResource implements ManagedResource {
  public readonly name = "webhook-delivery-worker";
  readonly #worker: Worker<WebhookDeliveryJobData>;
  readonly #redis: Redis;

  public constructor(options: {
    readonly redis: Redis;
    readonly connection: Connection;
    readonly config: RuntimeConfig;
    readonly logger: Logger;
    readonly allowedTestDestinations?: readonly string[];
  }) {
    this.#redis = options.redis;
    const models = registerPersistenceModels(options.connection);
    const client = new WebhookDeliveryClient(
      options.config.webhooks,
      options.config.nodeEnv,
      options.logger,
      options.allowedTestDestinations === undefined
        ? {}
        : { allowedTestDestinations: options.allowedTestDestinations },
    );
    const maxAttempts = options.config.webhooks.maxAttempts;
    const processor: Processor<WebhookDeliveryJobData> = async (job) => {
      const { deliveryId } = job.data;
      const row = await models.WebhookDelivery.findOne({ deliveryId }).lean();
      if (row === null) return;
      if (row.status === "delivered" || row.status === "dead_letter") return;

      const merchant = await models.Merchant.findOne({
        merchantId: row.merchantId,
      }).lean();
      const url = merchant?.webhookUrl;
      if (typeof url !== "string" || url.length === 0) {
        await models.WebhookDelivery.updateOne(
          { deliveryId, status: { $ne: "delivered" } },
          { $set: { status: "dead_letter", nextAttemptAt: null } },
        );
        return;
      }

      const claimed = await models.WebhookDelivery.updateOne(
        { deliveryId, status: { $in: ["pending", "delivering"] } },
        { $set: { status: "delivering" } },
      );
      if (claimed.modifiedCount !== 1) return;

      const body = Buffer.from(stableStringify(row.payload), "utf8");
      const { headers } = signedWebhookHeaders(
        options.config.webhooks,
        deliveryId,
        body,
      );
      headers["traceparent"] = traceParentHeader(generateTraceContext());
      try {
        const validated = validateWebhookUrl(url, options.config.nodeEnv);
        const response = await client.deliver(validated, body, headers);
        if (response.ok) {
          await models.WebhookDelivery.updateOne(
            { deliveryId },
            {
              $set: {
                status: "delivered",
                deliveredAt: new Date(),
                lastResponseCode: response.status,
                nextAttemptAt: null,
                expiresAt: new Date(
                  Date.now() + options.config.webhooks.retentionSec * 1000,
                ),
              },
            },
          );
          return;
        }
        throw new WebhookDeliveryError(
          response.failure === "redirect" ? "redirect" : "http_error",
          response.status,
        );
      } catch (error: unknown) {
        if (error instanceof WebhookDeliveryError) {
          // Exactly one failure record per BullMQ attempt.
          await this.#recordFailure(
            models,
            deliveryId,
            error.statusCode,
            job,
            maxAttempts,
          );
        }
        throw error;
      }
    };
    this.#worker = new Worker<WebhookDeliveryJobData>(
      webhookDeliveryQueueName,
      processor,
      {
        prefix: options.config.redis.queuePrefix,
        connection: options.redis,
        concurrency: 4,
        settings: {
          backoffStrategy: (attemptsMade: number) =>
            webhookBackoffDelayMs(attemptsMade),
        },
      },
    );
    this.#worker.on(
      "failed",
      (job: Job<WebhookDeliveryJobData> | undefined, error: Error) => {
        options.logger.warn(
          {
            err: error,
            jobId: job?.id,
            deliveryId: job?.data.deliveryId,
            attemptsMade: job?.attemptsMade,
          },
          "Webhook delivery attempt failed",
        );
      },
    );
  }

  async #recordFailure(
    models: ReturnType<typeof registerPersistenceModels>,
    deliveryId: string,
    responseCode: number | undefined,
    job: Job<WebhookDeliveryJobData>,
    maxAttempts: number,
  ): Promise<void> {
    const attempts = job.attemptsMade + 1;
    const exhausted = attempts >= maxAttempts;
    await models.WebhookDelivery.updateOne(
      { deliveryId },
      {
        $set: {
          status: exhausted ? "dead_letter" : "pending",
          ...(responseCode === undefined ? {} : { lastResponseCode: responseCode }),
          nextAttemptAt: exhausted
            ? null
            : new Date(Date.now() + webhookBackoffDelayMs(attempts)),
        },
        $inc: { attempts: 1 },
      },
    );
  }

  public async start(): Promise<void> {
    await this.#redis.ping();
  }

  public async stop(): Promise<void> {
    await this.#worker.close();
  }

  public async isReady(): Promise<boolean> {
    if (this.#redis.status !== "ready") return false;
    await this.#redis.ping();
    return true;
  }
}
