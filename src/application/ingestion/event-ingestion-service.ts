import { createHash } from "node:crypto";

import type { Connection } from "mongoose";

import {
  isBaseUnitString,
  parseBaseUnits,
  formatBaseUnits,
} from "../../domain/money/base-unit.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";

export interface EventEnqueuer {
  enqueueInterpretation(eventId: string): Promise<unknown>;
}

export interface IngestEventInput {
  readonly chain: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly contractAddress: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amount: string;
  readonly rawEvent: Readonly<Record<string, unknown>>;
  readonly confirmationsAtIngest?: number;
}

export interface IngestionOutcome {
  readonly eventId: string;
  readonly replayed: boolean;
}

/**
 * Server-side event identity. Every producer and every retry collapses onto
 * one identity; clients never choose it.
 */
export function deriveEventId(
  chain: string,
  transactionHash: string,
  logIndex: number,
): string {
  const digest = createHash("sha256")
    .update(`${chain}|${transactionHash}|${logIndex}`, "utf8")
    .digest("hex");
  return `event_${digest}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === 11_000
  );
}

function normalizeAmount(amount: string): string {
  return formatBaseUnits(parseBaseUnits(amount));
}

/**
 * Single persistence boundary for raw on-chain events (ADR 0010). The full
 * raw payload is written verbatim through one atomic insert before any
 * interpretation; duplicate ingestion is an idempotent no-op enforced by the
 * database unique indexes.
 */
export class EventIngestionService {
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #queue: EventEnqueuer;

  public constructor(connection: Connection, queue: EventEnqueuer) {
    this.#models = registerPersistenceModels(connection);
    this.#queue = queue;
  }

  public async ingest(input: IngestEventInput): Promise<IngestionOutcome> {
    if (!isBaseUnitString(input.amount)) {
      throw new TypeError("Event amount must be a canonical base-unit integer string");
    }
    const eventId = deriveEventId(input.chain, input.transactionHash, input.logIndex);
    const ingestedAt = new Date();
    const document = {
      eventId,
      chain: input.chain,
      contractAddress: input.contractAddress,
      normalizedContractAddress: input.contractAddress.toLowerCase(),
      transactionHash: input.transactionHash,
      logIndex: input.logIndex,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      fromAddress: input.fromAddress,
      normalizedFromAddress: input.fromAddress.toLowerCase(),
      toAddress: input.toAddress,
      normalizedToAddress: input.toAddress.toLowerCase(),
      amount: normalizeAmount(input.amount),
      rawEvent: input.rawEvent,
      canonical: true,
      ingestedAt,
      ...(input.confirmationsAtIngest === undefined
        ? {}
        : { confirmationsAtIngest: input.confirmationsAtIngest }),
    };

    let replayed = false;
    try {
      await this.#models.OnChainEvent.create(document);
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) throw error;
      replayed = true;
    }

    // Enqueue on every persisted path: a crash between the insert and the
    // original enqueue is recovered by the producer's retry, and the
    // deterministic jobId keeps the effective outcome exactly once.
    await this.#queue.enqueueInterpretation(eventId);

    return { eventId, replayed };
  }
}
