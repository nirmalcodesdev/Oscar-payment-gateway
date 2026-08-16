import { Queue, type BackoffStrategy, type Job } from "bullmq";
import type { Redis } from "ioredis";

import type { ManagedResource } from "../lifecycle/managed-resource.js";

export const eventInterpretationQueueName = "event-interpretation";

export const interpretationJobAttempts = 5;
export const interpretationBackoffDelayMs = 1_000;
export const interpretationBackoffCapMs = 60_000;
export const interpretationJitterCapMs = 1_000;

export interface EventInterpretationJobData {
  readonly eventId: string;
}

/**
 * Exponential backoff with jitter (ADR 0010 queue contract). The worker must
 * be constructed with the same strategy function so retry delays are computed
 * consistently; the strategy receives the job's `backoff.delay` as the base.
 */
export const jitteredBackoffStrategy: BackoffStrategy = (
  attemptsMade,
  type,
  _error,
  job,
) => {
  const baseDelay =
    typeof job?.opts.backoff === "object" && typeof job.opts.backoff.delay === "number"
      ? job.opts.backoff.delay
      : interpretationBackoffDelayMs;
  const base = baseDelay * 2 ** Math.max(0, attemptsMade - 1);
  const cappedBase = Math.min(base, interpretationBackoffCapMs);
  const jitter = Math.floor(
    Math.random() * Math.min(cappedBase, interpretationJitterCapMs),
  );
  return cappedBase + jitter;
};

/**
 * Durable interpretation queue. Job IDs are the deterministic `eventId`, so
 * duplicate ingestion paths enqueue at most one effective job; database
 * uniqueness remains the final correctness boundary.
 *
 * BullMQ composes Redis keys as `${prefix}:${queueName}`, so the prefix is
 * passed as the queue option and the bare name as the queue name; the
 * effective key namespace is `${queuePrefix}:event-interpretation` (ADR 0010).
 */
export class EventQueue {
  readonly #queue: Queue<EventInterpretationJobData, unknown>;

  public constructor(redis: Redis, queuePrefix: string) {
    this.#queue = new Queue<EventInterpretationJobData, unknown, string>(
      eventInterpretationQueueName,
      {
        prefix: queuePrefix,
        connection: redis,
        defaultJobOptions: {
          attempts: interpretationJobAttempts,
          backoff: { type: "custom", delay: interpretationBackoffDelayMs },
          removeOnComplete: true,
          removeOnFail: false,
        },
      },
    );
  }

  /**
   * Enqueue interpretation work for an event. A duplicate `jobId` collapses
   * onto the existing job; the effective outcome stays exactly once.
   */
  public async enqueueInterpretation(
    eventId: string,
  ): Promise<Job<EventInterpretationJobData> | undefined> {
    return this.#queue.add("interpret", { eventId }, { jobId: eventId });
  }

  public async close(): Promise<void> {
    await this.#queue.close();
  }
}

/**
 * Lifecycle wrapper for the API process (ADR 0004). The underlying Redis
 * connection is owned by `RedisResource`; BullMQ detects the shared instance
 * and never disconnects it, so stopping only releases queue-local state.
 */
export class EventQueueResource implements ManagedResource {
  public readonly name = "event-interpretation-queue";
  readonly #queue: EventQueue;
  readonly #redis: Redis;

  public constructor(redis: Redis, queuePrefix: string) {
    this.#redis = redis;
    this.#queue = new EventQueue(redis, queuePrefix);
  }

  public get queue(): EventQueue {
    return this.#queue;
  }

  public async start(): Promise<void> {
    await this.#redis.ping();
  }

  public async stop(): Promise<void> {
    await this.#queue.close();
  }

  public async isReady(): Promise<boolean> {
    if (this.#redis.status !== "ready") return false;
    await this.#redis.ping();
    return true;
  }
}
