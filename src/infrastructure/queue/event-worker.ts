import { Worker, type Processor } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

import type { EventInterpretationService } from "../../application/ingestion/event-interpretation-service.js";
import type { PaymentMatchingService } from "../../application/processing/payment-matching-service.js";
import type { ManagedResource } from "../lifecycle/managed-resource.js";
import {
  eventInterpretationQueueName,
  jitteredBackoffStrategy,
  type EventInterpretationJobData,
} from "./event-queue.js";

/**
 * Durable interpretation worker for the processor process (ADR 0004). The
 * worker re-reads the event and current registry state from MongoDB for each
 * job; database uniqueness and conditional writes keep the effective outcome
 * exactly once even under duplicate delivery. Accepted events continue
 * directly into payment matching (ADR 0011) inside the same deterministic
 * job, so a collapsed duplicate delivery can never skip the match step.
 */
export class EventInterpretationWorkerResource implements ManagedResource {
  public readonly name = "event-interpretation-worker";
  readonly #worker: Worker<EventInterpretationJobData>;
  readonly #redis: Redis;

  public constructor(options: {
    readonly redis: Redis;
    readonly queuePrefix: string;
    readonly service: EventInterpretationService;
    readonly logger: Logger;
    readonly matching?: PaymentMatchingService;
  }) {
    this.#redis = options.redis;
    const processor: Processor<EventInterpretationJobData> = async (job) => {
      const { eventId } = job.data;
      const outcome = await options.service.interpret(eventId, options.logger);
      if (outcome.status === "accepted" && options.matching !== undefined) {
        await options.matching.matchEvent(eventId, options.logger);
      }
    };
    this.#worker = new Worker<EventInterpretationJobData>(
      eventInterpretationQueueName,
      processor,
      {
        prefix: options.queuePrefix,
        connection: options.redis,
        concurrency: 4,
        settings: {
          backoffStrategy: jitteredBackoffStrategy,
        },
      },
    );
    this.#worker.on("failed", (job, error) => {
      options.logger.error(
        { err: error, jobId: job?.id, eventId: job?.data.eventId },
        "Event interpretation job failed",
      );
    });
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
