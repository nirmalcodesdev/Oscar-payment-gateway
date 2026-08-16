import { Queue, Worker, type Job, type Processor } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

import type { PaymentConfirmationEnqueuer } from "../../application/processing/payment-matching-service.js";
import type { PaymentConfirmationService } from "../../application/processing/payment-confirmation-service.js";
import type { ManagedResource } from "../lifecycle/managed-resource.js";

export const paymentConfirmationQueueName = "payment-confirmation";

export const confirmationJobAttempts = 5;
export const confirmationBackoffDelayMs = 1_000;
export const confirmationBackoffCapMs = 60_000;
export const confirmationJitterCapMs = 1_000;

export interface PaymentConfirmationJobData {
  readonly paymentId: string;
}

/**
 * Exponential backoff with jitter, mirroring the interpretation queue
 * contract (ADR 0010). The worker must be constructed with the same
 * strategy so retry delays are computed consistently.
 */
export const confirmationBackoffStrategy = (attemptsMade: number): number => {
  const base = confirmationBackoffDelayMs * 2 ** Math.max(0, attemptsMade - 1);
  const capped = Math.min(base, confirmationBackoffCapMs);
  return capped + Math.floor(Math.random() * Math.min(capped, confirmationJitterCapMs));
};

/**
 * Durable confirmation queue (ADR 0012). Job ids are the deterministic
 * `paymentId`, so duplicate enqueues collapse; while a payment waits for
 * depth, canonicality, or screening, the job re-enqueues itself with the
 * same id and a poll-interval delay, keeping at most one active job per
 * payment across any number of workers.
 */
export class PaymentConfirmationQueue implements PaymentConfirmationEnqueuer {
  readonly #queue: Queue<PaymentConfirmationJobData, unknown>;
  readonly #pollIntervalMs: number;

  public constructor(redis: Redis, queuePrefix: string, pollIntervalMs: number) {
    this.#queue = new Queue<PaymentConfirmationJobData, unknown, string>(
      paymentConfirmationQueueName,
      {
        prefix: queuePrefix,
        connection: redis,
        defaultJobOptions: {
          attempts: confirmationJobAttempts,
          backoff: { type: "custom", delay: confirmationBackoffDelayMs },
          removeOnComplete: true,
          removeOnFail: false,
        },
      },
    );
    this.#pollIntervalMs = pollIntervalMs;
  }

  public async enqueueConfirmation(paymentId: string): Promise<void> {
    await this.#queue.add("confirm", { paymentId }, { jobId: paymentId });
  }

  public async reschedule(paymentId: string): Promise<void> {
    await this.#queue.add(
      "confirm",
      { paymentId },
      { jobId: paymentId, delay: this.#pollIntervalMs },
    );
  }

  public async close(): Promise<void> {
    await this.#queue.close();
  }
}

/**
 * Processor-side worker: advances one payment one state-machine step per
 * job; a waiting outcome keeps exactly one delayed job alive.
 */
export class PaymentConfirmationWorkerResource implements ManagedResource {
  public readonly name = "payment-confirmation-worker";
  readonly #worker: Worker<PaymentConfirmationJobData>;
  readonly #redis: Redis;
  readonly #queue: PaymentConfirmationQueue;

  public constructor(options: {
    readonly redis: Redis;
    readonly queuePrefix: string;
    readonly pollIntervalMs: number;
    readonly service: PaymentConfirmationService;
    readonly logger: Logger;
  }) {
    this.#redis = options.redis;
    this.#queue = new PaymentConfirmationQueue(
      options.redis,
      options.queuePrefix,
      options.pollIntervalMs,
    );
    const processor: Processor<PaymentConfirmationJobData> = async (job) => {
      const { paymentId } = job.data;
      const outcome = await options.service.advancePayment(paymentId, options.logger);
      if (outcome.outcome === "waiting") {
        await this.#queue.reschedule(paymentId);
      }
    };
    this.#worker = new Worker<PaymentConfirmationJobData>(
      paymentConfirmationQueueName,
      processor,
      {
        prefix: options.queuePrefix,
        connection: options.redis,
        concurrency: 4,
        settings: {
          backoffStrategy: (attemptsMade) => confirmationBackoffStrategy(attemptsMade),
        },
      },
    );
    this.#worker.on(
      "failed",
      (job: Job<PaymentConfirmationJobData> | undefined, error: Error) => {
        options.logger.error(
          { err: error, jobId: job?.id, paymentId: job?.data.paymentId },
          "Payment confirmation job failed",
        );
      },
    );
  }

  public async start(): Promise<void> {
    await this.#redis.ping();
  }

  public async stop(): Promise<void> {
    await this.#worker.close();
    await this.#queue.close();
  }

  public async isReady(): Promise<boolean> {
    if (this.#redis.status !== "ready") return false;
    await this.#redis.ping();
    return true;
  }
}
