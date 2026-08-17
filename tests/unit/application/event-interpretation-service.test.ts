import { createHash } from "node:crypto";
import type { Connection } from "mongoose";
import pino from "pino";
import { describe, expect, it } from "vitest";

import {
  EventInterpretationService,
  decodeTransferFromRaw,
} from "../../../src/application/ingestion/event-interpretation-service.js";
import { type EnabledRegistryReader } from "../../../src/application/registry/registry-reader.js";
import type {
  BalanceDeltaRead,
  BalanceDeltaReader,
} from "../../../src/domain/chain/chain-adapter.js";

const logger = pino({ level: "silent" });

const chain = "ethereum-sepolia";
const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const fromAddress = "0x2222222222222222222222222222222222222222";
const toAddress = "0xeeee333333333333333333333333333333333333";
const contractAddress = "0xabcd111111111111111111111111111111111111";

const topicFor = (address: string) =>
  `0x000000000000000000000000${address.slice(2).toLowerCase()}`;
const dataFor = (amount: bigint) => `0x${amount.toString(16).padStart(64, "0")}`;

function rawEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    topics: [transferTopic, topicFor(fromAddress), topicFor(toAddress)],
    data: dataFor(900n),
    ...overrides,
  };
}

function storedEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    eventId: "event_test",
    chain,
    contractAddress: "0xABCD111111111111111111111111111111111111",
    normalizedContractAddress: contractAddress,
    transactionHash: `0x${"3".repeat(64)}`,
    logIndex: 0,
    blockNumber: 100,
    blockHash: `0x${"a".repeat(64)}`,
    fromAddress: "0x2222222222222222222222222222222222222222",
    normalizedFromAddress: fromAddress,
    toAddress: "0xEEEE333333333333333333333333333333333333",
    normalizedToAddress: toAddress,
    amount: "900",
    rawEvent: rawEvent(),
    ...overrides,
  };
}

function nativeRawEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    hash: "0x11",
    from: fromAddress,
    to: toAddress,
    value: "900",
    ...overrides,
  };
}

function nativeStoredEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return storedEvent({
    assetType: "native",
    contractAddress: undefined,
    normalizedContractAddress: undefined,
    logIndex: undefined,
    amount: "900",
    rawEvent: nativeRawEvent(),
    ...overrides,
  });
}

interface RegistryOptions {
  readonly chains?: readonly string[];
  readonly tokens?: {
    readonly chain: string;
    readonly assetType?: "erc20" | "native";
    readonly normalizedContractAddress?: string;
    readonly tokenId?: string;
    readonly verificationPolicy?: "event_only" | "balance_delta_required";
  }[];
  readonly walletAddress?: string;
}

function registryReader(options: RegistryOptions = {}): EnabledRegistryReader {
  const snapshot = {
    revision: createHash("sha256").update(JSON.stringify(options)).digest("hex"),
    loadedAt: new Date("2026-08-15T12:00:00.000Z"),
    chains: (options.chains ?? [chain]).map((chainId) => ({ chainId })),
    tokens: (
      options.tokens ?? [
        {
          chain,
          normalizedContractAddress: contractAddress,
          tokenId: "token-usdc-sepolia",
          verificationPolicy: "event_only" as const,
        },
      ]
    ).map((token) => ({
      tokenId: token.tokenId ?? "token-usdc-sepolia",
      chain: token.chain,
      assetType: token.assetType ?? ("erc20" as const),
      symbol: "USDC",
      verificationPolicy: token.verificationPolicy ?? ("event_only" as const),
      ...(token.normalizedContractAddress === undefined
        ? {}
        : { normalizedContractAddress: token.normalizedContractAddress }),
    })),
  };
  return {
    refresh: () => Promise.resolve(snapshot),
  } as unknown as EnabledRegistryReader;
}

function deltaReader(
  response:
    | BalanceDeltaRead
    | ((input: Parameters<BalanceDeltaReader["readDelta"]>[0]) => BalanceDeltaRead),
): {
  readonly reader: BalanceDeltaReader;
  readonly calls: Parameters<BalanceDeltaReader["readDelta"]>[0][];
} {
  const calls: Parameters<BalanceDeltaReader["readDelta"]>[0][] = [];
  return {
    calls,
    reader: {
      readDelta: (input) => {
        calls.push(input);
        return Promise.resolve(
          typeof response === "function" ? response(input) : response,
        );
      },
    },
  };
}

/**
 * Detached connection with an in-memory event store: `findOne` reads,
 * `findOneAndUpdate` honors the `interpretationStatus: { $exists: false }`
 * guard so duplicate interpretation is a storage-level no-op.
 */
function fakeConnection(options: {
  readonly events?: Record<string, unknown>[];
  readonly wallets?: { chain: string; normalizedAddress: string }[];
  /** When true, the first finalization write loses the race and returns null. */
  readonly loseFinalizeRaceOnce?: boolean;
}): {
  readonly connection: Connection;
  readonly events: Map<string, Record<string, unknown>>;
} {
  const events = new Map<string, Record<string, unknown>>(
    (options.events ?? []).map((event) => [event["eventId"] as string, { ...event }]),
  );
  const wallets = options.wallets ?? [{ chain, normalizedAddress: toAddress }];
  let raceLost = false;
  const models: Record<string, unknown> = {};
  const connection = {
    models,
    model(name: string) {
      const existing = models[name];
      if (existing !== undefined) return existing;
      let model: unknown = {};
      if (name === "OnChainEvent") {
        model = {
          findOne(query: { eventId: string }) {
            const doc = events.get(query.eventId);
            return { lean: () => Promise.resolve(doc ?? null) };
          },
          findOneAndUpdate(
            query: { eventId: string; interpretationStatus?: unknown },
            update: { $set: Record<string, unknown> },
          ) {
            const doc = events.get(query.eventId);
            const alreadyInterpreted = doc?.["interpretationStatus"] !== undefined;
            if (
              doc === undefined ||
              (query.interpretationStatus !== undefined && alreadyInterpreted) ||
              (options.loseFinalizeRaceOnce === true && !raceLost)
            ) {
              if (
                options.loseFinalizeRaceOnce === true &&
                !raceLost &&
                doc !== undefined
              ) {
                // The concurrent worker's write lands first.
                raceLost = true;
                doc["interpretationStatus"] = "review";
                doc["interpretationReason"] = "balance_delta_unavailable";
              }
              return { lean: () => Promise.resolve(null) };
            }
            Object.assign(doc, update.$set);
            return { lean: () => Promise.resolve(doc) };
          },
        };
      } else if (name === "WalletAddress") {
        model = {
          findOne(query: { chain: string; normalizedAddress: string }) {
            const match = wallets.find(
              (wallet) =>
                wallet.chain === query.chain &&
                wallet.normalizedAddress === query.normalizedAddress,
            );
            return { lean: () => Promise.resolve(match ?? null) };
          },
        };
      }
      models[name] = model;
      return model;
    },
  } as unknown as Connection;
  return { connection, events };
}

function service(
  connection: Connection,
  deltas: BalanceDeltaReader,
  reader: EnabledRegistryReader,
): EventInterpretationService {
  return new EventInterpretationService(connection, deltas, reader);
}

describe("decodeTransferFromRaw", () => {
  it("decodes a canonical transfer into normalized lowercase addresses", () => {
    expect(decodeTransferFromRaw(rawEvent())).toEqual({
      fromAddress,
      toAddress,
      amount: "900",
    });
  });

  it("decodes uppercase data and large amounts exactly", () => {
    const decoded = decodeTransferFromRaw(
      rawEvent({
        data: `0x${(10n ** 21n).toString(16).toUpperCase().padStart(64, "0")}`,
      }),
    );
    expect(decoded?.amount).toBe("1000000000000000000000");
  });

  it("decodes zero-value transfers; rejection is a downstream judgment", () => {
    expect(decodeTransferFromRaw(rawEvent({ data: dataFor(0n) }))?.amount).toBe("0");
  });

  it("rejects shapes that are not a canonical two-topic transfer", () => {
    expect(decodeTransferFromRaw({})).toBeUndefined();
    expect(
      decodeTransferFromRaw({ topics: "nope", data: dataFor(1n) }),
    ).toBeUndefined();
    expect(
      decodeTransferFromRaw({ topics: [transferTopic, topicFor(fromAddress)] }),
    ).toBeUndefined();
    expect(
      decodeTransferFromRaw(
        rawEvent({
          topics: [`0x${"e".repeat(64)}`, topicFor(fromAddress), topicFor(toAddress)],
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeTransferFromRaw(
        rawEvent({ topics: [transferTopic, "0x12", topicFor(toAddress)] }),
      ),
    ).toBeUndefined();
    expect(
      decodeTransferFromRaw(
        rawEvent({ topics: [transferTopic, topicFor(fromAddress), 42] }),
      ),
    ).toBeUndefined();
  });

  it("rejects malformed amount words", () => {
    expect(decodeTransferFromRaw(rawEvent({ data: "0x01" }))).toBeUndefined();
    expect(
      decodeTransferFromRaw(rawEvent({ data: `0x${"g".repeat(64)}` })),
    ).toBeUndefined();
    expect(decodeTransferFromRaw(rawEvent({ data: 900 }))).toBeUndefined();
  });
});

describe("EventInterpretationService judgment tables", () => {
  it("rejects events for a disabled or unknown chain", async () => {
    const { connection } = fakeConnection({ events: [storedEvent()] });
    const { reader } = deltaReader({ status: "unavailable" });
    const interpreter = service(
      connection,
      reader,
      registryReader({ chains: ["polygon-mainnet"] }),
    );

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toMatchObject({
      eventId: "event_test",
      status: "rejected",
      reason: "disabled_or_unknown_chain",
      applied: true,
    });
  });

  it("rejects a log whose raw capture does not match the normalized fields", async () => {
    const { connection } = fakeConnection({
      events: [storedEvent({ rawEvent: rawEvent({ data: dataFor(800n) }) })],
    });
    const { reader } = deltaReader({ status: "unavailable" });
    const interpreter = service(connection, reader, registryReader());

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "malformed_log",
      applied: true,
    });
  });

  it("rejects an undecodable raw log", async () => {
    const { connection } = fakeConnection({
      events: [storedEvent({ rawEvent: { topics: [], data: "0x" } })],
    });
    const { reader } = deltaReader({ status: "unavailable" });
    const interpreter = service(connection, reader, registryReader());

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toMatchObject({ status: "rejected", reason: "malformed_log" });
  });

  it("rejects events for an unknown or disabled token contract", async () => {
    const { connection } = fakeConnection({ events: [storedEvent()] });
    const { reader } = deltaReader({ status: "unavailable" });
    const interpreter = service(
      connection,
      reader,
      registryReader({
        tokens: [
          {
            chain,
            normalizedContractAddress: `0x${"7".repeat(40)}`,
            tokenId: "token-other",
          },
        ],
      }),
    );

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "unknown_or_disabled_token",
    });
  });

  it("rejects events addressed to an unknown recipient wallet", async () => {
    const { connection } = fakeConnection({ events: [storedEvent()], wallets: [] });
    const { reader } = deltaReader({ status: "unavailable" });
    const interpreter = service(connection, reader, registryReader());

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toMatchObject({ status: "rejected", reason: "unknown_recipient" });
  });

  it("accepts event-only tokens without consulting the balance delta reader", async () => {
    const { connection, events } = fakeConnection({ events: [storedEvent()] });
    const deltas = deltaReader({ status: "unavailable" });
    const interpreter = service(connection, deltas.reader, registryReader());

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toEqual({
      eventId: "event_test",
      status: "accepted",
      applied: true,
    });
    expect(deltas.calls).toEqual([]);
    expect(events.get("event_test")).toMatchObject({
      interpretationStatus: "accepted",
      token: "token-usdc-sepolia",
      interpretationRevision: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      interpretedAt: expect.any(Date) as Date,
    });
  });

  it.each([
    [{ status: "agreeing", delta: "900" }, "accepted"],
    [{ status: "disagreement" }, "review"],
    [{ status: "unavailable" }, "review"],
  ] as const)(
    "maps a balance-delta outcome %j to %s",
    async (delta, expectedStatus) => {
      const { connection } = fakeConnection({ events: [storedEvent()] });
      const deltas = deltaReader(delta);
      const interpreter = service(
        connection,
        deltas.reader,
        registryReader({
          tokens: [
            {
              chain,
              normalizedContractAddress: contractAddress,
              verificationPolicy: "balance_delta_required",
            },
          ],
        }),
      );

      const outcome = await interpreter.interpret("event_test", logger);
      expect(outcome.status).toBe(expectedStatus);
      expect(deltas.calls).toEqual([
        {
          chain,
          contractAddress,
          holder: toAddress,
          blockNumber: 100,
        },
      ]);
    },
  );

  it("records the agreed delta as the verified received amount", async () => {
    const { connection, events } = fakeConnection({ events: [storedEvent()] });
    const deltas = deltaReader({ status: "agreeing", delta: "850" });
    const interpreter = service(
      connection,
      deltas.reader,
      registryReader({
        tokens: [
          {
            chain,
            normalizedContractAddress: contractAddress,
            verificationPolicy: "balance_delta_required",
          },
        ],
      }),
    );

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toMatchObject({
      status: "accepted",
      verifiedReceivedAmount: "850",
    });
    expect(events.get("event_test")).toMatchObject({
      verifiedReceivedAmount: "850",
      interpretationStatus: "accepted",
    });
  });

  it.each(["0", "-5"])(
    "sends a non-positive balance delta %j to review",
    async (delta) => {
      const { connection } = fakeConnection({ events: [storedEvent()] });
      const deltas = deltaReader({ status: "agreeing", delta });
      const interpreter = service(
        connection,
        deltas.reader,
        registryReader({
          tokens: [
            {
              chain,
              normalizedContractAddress: contractAddress,
              verificationPolicy: "balance_delta_required",
            },
          ],
        }),
      );

      const outcome = await interpreter.interpret("event_test", logger);
      expect(outcome).toMatchObject({
        status: "review",
        reason: "balance_delta_negative",
      });
    },
  );

  it("throws when the queued event was never persisted", async () => {
    const { connection } = fakeConnection({ events: [] });
    const { reader } = deltaReader({ status: "unavailable" });
    const interpreter = service(connection, reader, registryReader());

    await expect(interpreter.interpret("event_missing", logger)).rejects.toThrow(
      "event_missing",
    );
  });

  it("accepts a native value transfer against the native token", async () => {
    const { connection, events } = fakeConnection({ events: [nativeStoredEvent()] });
    const deltas = deltaReader({ status: "unavailable" });
    const interpreter = service(
      connection,
      deltas.reader,
      registryReader({
        tokens: [{ chain, assetType: "native", tokenId: "token-native" }],
      }),
    );

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toMatchObject({ status: "accepted" });
    expect(deltas.calls).toEqual([]);
    expect(events.get("event_test")).toMatchObject({
      interpretationStatus: "accepted",
      token: "token-native",
    });
  });

  it("rejects a native event whose amount is zero", async () => {
    const { connection } = fakeConnection({
      events: [
        nativeStoredEvent({ amount: "0", rawEvent: nativeRawEvent({ value: "0" }) }),
      ],
    });
    const deltas = deltaReader({ status: "unavailable" });
    const interpreter = service(
      connection,
      deltas.reader,
      registryReader({
        tokens: [{ chain, assetType: "native", tokenId: "token-native" }],
      }),
    );

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "nonzero_value_missing",
    });
  });

  it("rejects a native event for a chain with no native token", async () => {
    const { connection } = fakeConnection({ events: [nativeStoredEvent()] });
    const deltas = deltaReader({ status: "unavailable" });
    const interpreter = service(
      connection,
      deltas.reader,
      registryReader({ tokens: [] }),
    );

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "unknown_or_disabled_token",
    });
  });
});

describe("EventInterpretationService duplicate delivery", () => {
  it("returns the stored outcome without rewriting on redelivery", async () => {
    const { connection, events } = fakeConnection({ events: [storedEvent()] });
    const deltas = deltaReader({ status: "agreeing", delta: "900" });
    const interpreter = service(connection, deltas.reader, registryReader());

    const first = await interpreter.interpret("event_test", logger);
    expect(first).toMatchObject({ status: "accepted", applied: true });
    const interpretedAt = events.get("event_test")?.["interpretedAt"];

    const second = await interpreter.interpret("event_test", logger);
    expect(second).toMatchObject({
      eventId: "event_test",
      status: "accepted",
      applied: false,
    });
    // The redelivery did not touch the interpretation state.
    expect(events.get("event_test")?.["interpretedAt"]).toBe(interpretedAt);
    expect(deltas.calls).toHaveLength(0);
  });

  it("defers to the outcome a concurrent worker wrote first", async () => {
    const { connection } = fakeConnection({
      events: [storedEvent()],
      loseFinalizeRaceOnce: true,
    });
    const { reader } = deltaReader({ status: "agreeing", delta: "900" });
    const interpreter = service(connection, reader, registryReader());

    const outcome = await interpreter.interpret("event_test", logger);
    expect(outcome).toMatchObject({
      status: "review",
      reason: "balance_delta_unavailable",
      applied: false,
    });
  });
});
