import type { Connection } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  EventIngestionService,
  deriveEventId,
  type IngestEventInput,
} from "../../../src/application/ingestion/event-ingestion-service.js";

const chain = "ethereum-sepolia";
const transactionHash = `0x${"3".repeat(64)}`;

/**
 * Detached connection whose only live model is OnChainEvent, backed by an
 * in-memory set keyed by eventId — the unique index that makes duplicate
 * ingestion an idempotent no-op.
 */
function fakeConnection(): {
  readonly connection: Connection;
  readonly created: Record<string, unknown>[];
  readonly inserted: Set<string>;
} {
  const created: Record<string, unknown>[] = [];
  const inserted = new Set<string>();
  const models: Record<string, unknown> = {};
  const connection = {
    models,
    model(name: string) {
      const existing = models[name];
      if (existing !== undefined) return existing;
      const model =
        name === "OnChainEvent"
          ? {
              create(document: Record<string, unknown>) {
                const eventId = document["eventId"];
                if (typeof eventId === "string" && inserted.has(eventId)) {
                  const error = new Error("E11000 duplicate key") as Error & {
                    code: number;
                  };
                  error.code = 11_000;
                  return Promise.reject(error);
                }
                if (typeof eventId === "string") inserted.add(eventId);
                created.push(document);
                return Promise.resolve(document);
              },
            }
          : {};
      models[name] = model;
      return model;
    },
  } as unknown as Connection;
  return { connection, created, inserted };
}

function recordingQueue(): {
  readonly queue: { enqueueInterpretation(eventId: string): Promise<unknown> };
  readonly enqueued: string[];
} {
  const enqueued: string[] = [];
  return {
    queue: {
      enqueueInterpretation: (eventId: string) => {
        enqueued.push(eventId);
        return Promise.resolve();
      },
    },
    enqueued,
  };
}

function input(overrides: Partial<IngestEventInput> = {}): IngestEventInput {
  return {
    chain,
    transactionHash,
    logIndex: 7,
    blockNumber: 100,
    blockHash: `0x${"a".repeat(64)}`,
    contractAddress: "0xAbCd111111111111111111111111111111111111",
    fromAddress: "0x2222222222222222222222222222222222222222",
    toAddress: "0xEEEE333333333333333333333333333333333333",
    amount: "900",
    rawEvent: { topics: ["0xdeadbeef"] },
    ...overrides,
  };
}

describe("deriveEventId", () => {
  it("is deterministic and prefixed with event_", () => {
    const first = deriveEventId(chain, transactionHash, 7);
    const second = deriveEventId(chain, transactionHash, 7);
    expect(first).toBe(second);
    expect(first).toMatch(/^event_[0-9a-f]{64}$/);
  });

  it("produces a distinct identity for every identity component", () => {
    const baseline = deriveEventId(chain, transactionHash, 7);
    const variants = [
      deriveEventId("bitcoin-mainnet", transactionHash, 7),
      deriveEventId(chain, `0x${"4".repeat(64)}`, 7),
      deriveEventId(chain, transactionHash, 8),
    ];
    for (const variant of variants) {
      expect(variant).not.toBe(baseline);
    }
  });
});

describe("EventIngestionService", () => {
  it("persists the raw event verbatim with normalized fields before enqueuing", async () => {
    const { connection, created } = fakeConnection();
    const { queue, enqueued } = recordingQueue();
    const service = new EventIngestionService(connection, queue);

    const outcome = await service.ingest(input());
    const eventId = deriveEventId(chain, transactionHash, 7);

    expect(outcome).toEqual({ eventId, replayed: false });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      eventId,
      chain,
      transactionHash,
      logIndex: 7,
      blockNumber: 100,
      contractAddress: "0xAbCd111111111111111111111111111111111111",
      normalizedContractAddress: "0xabcd111111111111111111111111111111111111",
      normalizedFromAddress: "0x2222222222222222222222222222222222222222",
      normalizedToAddress: "0xeeee333333333333333333333333333333333333",
      amount: "900",
      rawEvent: { topics: ["0xdeadbeef"] },
      canonical: true,
    });
    expect(created[0]?.["ingestedAt"]).toBeInstanceOf(Date);
    expect(created[0]).not.toHaveProperty("confirmationsAtIngest");
    expect(enqueued).toEqual([eventId]);
  });

  it("records confirmationsAtIngest only when provided", async () => {
    const { connection, created } = fakeConnection();
    const { queue } = recordingQueue();
    const service = new EventIngestionService(connection, queue);

    await service.ingest(input({ confirmationsAtIngest: 12 }));
    expect(created[0]).toMatchObject({ confirmationsAtIngest: 12 });
  });

  it.each(["0900", "-5", "9.5", "", "1e3"])(
    "rejects the non-canonical amount %j before persisting or enqueuing",
    async (amount) => {
      const { connection, created } = fakeConnection();
      const { queue, enqueued } = recordingQueue();
      const service = new EventIngestionService(connection, queue);

      await expect(service.ingest(input({ amount }))).rejects.toThrow(TypeError);
      expect(created).toEqual([]);
      expect(enqueued).toEqual([]);
    },
  );

  it("reports replayed when the same event identity arrives twice", async () => {
    const { connection, created } = fakeConnection();
    const { queue } = recordingQueue();
    const service = new EventIngestionService(connection, queue);

    const first = await service.ingest(input());
    const second = await service.ingest(input());

    expect(first.replayed).toBe(false);
    expect(second).toEqual({ eventId: first.eventId, replayed: true });
    // The raw capture is written once; duplicates never overwrite it.
    expect(created).toHaveLength(1);
  });

  it("enqueues interpretation on both the fresh and the replayed path", async () => {
    const { connection } = fakeConnection();
    const { queue, enqueued } = recordingQueue();
    const service = new EventIngestionService(connection, queue);

    const first = await service.ingest(input());
    await service.ingest(input());
    expect(enqueued).toEqual([first.eventId, first.eventId]);
  });

  it("surfaces non-duplicate persistence failures without enqueuing", async () => {
    const models: Record<string, unknown> = {};
    const connection = {
      models,
      model(name: string) {
        const existing = models[name];
        if (existing !== undefined) return existing;
        const model =
          name === "OnChainEvent"
            ? { create: () => Promise.reject(new Error("write concern failed")) }
            : {};
        models[name] = model;
        return model;
      },
    } as unknown as Connection;
    const { queue, enqueued } = recordingQueue();
    const service = new EventIngestionService(connection, queue);

    await expect(service.ingest(input())).rejects.toThrow("write concern failed");
    expect(enqueued).toEqual([]);
  });
});
