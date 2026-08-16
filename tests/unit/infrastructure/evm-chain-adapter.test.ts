import pino from "pino";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/environment.js";
import {
  UnsupportedChainFamilyError,
  createChainAdapter,
} from "../../../src/infrastructure/chain/chain-adapter-factory.js";
import {
  EvmChainAdapter,
  EvmChainAdapterError,
  decodeTransferLog,
  resolveChainProviderClients,
} from "../../../src/infrastructure/chain/evm-chain-adapter.js";
import type {
  EvmProviderClient,
  EvmProviderClientFactory,
} from "../../../src/infrastructure/chain/evm-registry-verifier.js";
import { erc20TransferTopic } from "../../../src/infrastructure/chain/evm-registry-verifier.js";
import { validEnvironment } from "../../helpers/environment.js";

const logger = pino({ level: "silent" });
const rpcConfig = loadConfig(validEnvironment()).rpc;
const references = [
  { providerId: "rpc-test-a", operatorId: "operator-a" },
  { providerId: "rpc-test-b", operatorId: "operator-b" },
] as const;
const chainRecord = {
  chainId: "ethereum-sepolia",
  networkChainId: 11155111,
  rpcProviders: references,
};

function client(overrides: Partial<EvmProviderClient> = {}): EvmProviderClient {
  return {
    getChainId: () => Promise.resolve(11155111),
    getBlockNumber: () => Promise.resolve(100n),
    getBytecode: () => Promise.resolve("0x6001600055"),
    readTokenMetadata: () =>
      Promise.resolve({
        decimals: 6,
        symbol: "USDC",
        totalSupply: 1n,
        nonStandard: [],
      }),
    getBlockHeader: (blockNumber) =>
      Promise.resolve({
        blockNumber: Number(blockNumber),
        blockHash: `0x${"a".repeat(64)}`,
        parentHash: `0x${"b".repeat(64)}`,
      }),
    getLogs: () => Promise.resolve([]),
    getTransactionReceipt: () =>
      Promise.resolve({ blockNumber: 100, blockHash: `0x${"a".repeat(64)}` }),
    readErc20Balance: () => Promise.resolve(0n),
    readErc20Decimals: () => Promise.resolve(6),
    ...overrides,
  };
}

function factoryFor(clients: Readonly<Record<string, EvmProviderClient>>) {
  const factory: EvmProviderClientFactory = {
    create(providerId) {
      const existing = clients[providerId];
      if (existing === undefined) throw new Error("Missing test provider");
      return existing;
    },
  };
  return factory;
}

function adapter(
  clients: Readonly<Record<string, EvmProviderClient>>,
  networkChainId = 11155111,
): EvmChainAdapter {
  return new EvmChainAdapter({
    chain: { ...chainRecord, networkChainId },
    config: rpcConfig,
    logger,
    factory: factoryFor(clients),
    pollIntervalMs: 5,
  });
}

const fromTopic = `0x000000000000000000000000${"1".repeat(40)}`;
const toTopic = `0x000000000000000000000000${"2".repeat(40)}`;

function transferEntry(
  overrides: Partial<Parameters<typeof decodeTransferLog>[0]> = {},
) {
  return {
    contractAddress: "0x1111111111111111111111111111111111111111",
    transactionHash: `0x${"3".repeat(64)}`,
    logIndex: 0,
    blockNumber: 100,
    blockHash: `0x${"a".repeat(64)}`,
    topics: [erc20TransferTopic, fromTopic, toTopic],
    data: `0x${"0".repeat(63)}1`,
    raw: {},
    ...overrides,
  };
}

describe("createChainAdapter factory selection", () => {
  it("selects the EVM adapter for the evm network family", () => {
    const created = createChainAdapter({
      chain: { ...chainRecord, networkFamily: "evm" },
      config: rpcConfig,
      logger,
      providerFactory: factoryFor({
        "rpc-test-a": client(),
        "rpc-test-b": client(),
      }),
    });
    expect(created.chainId).toBe("ethereum-sepolia");
    expect(created.providers()).toHaveLength(2);
  });

  it("fails closed for unsupported network families", () => {
    expect(() =>
      createChainAdapter({
        chain: { ...chainRecord, networkFamily: "solana" },
        config: rpcConfig,
        logger,
        providerFactory: factoryFor({}),
      }),
    ).toThrow(UnsupportedChainFamilyError);
  });
});

describe("resolveChainProviderClients", () => {
  it("resolves configured providers with matching operators", () => {
    const resolved = resolveChainProviderClients({
      chainId: chainRecord.chainId,
      rpcProviders: references,
      config: rpcConfig,
      factory: factoryFor({
        "rpc-test-a": client(),
        "rpc-test-b": client(),
      }),
    });
    expect(resolved.map(({ reference }) => reference.providerId)).toEqual([
      "rpc-test-a",
      "rpc-test-b",
    ]);
  });

  it.each([
    ["unknown provider id", [{ providerId: "rpc-unknown", operatorId: "operator-a" }]],
    ["operator mismatch", [{ providerId: "rpc-test-a", operatorId: "operator-b" }]],
    ["duplicate provider", [...references, references[0]]],
  ] as const)("rejects %s", (_label, rpcProviders) => {
    expect(() =>
      resolveChainProviderClients({
        chainId: chainRecord.chainId,
        rpcProviders,
        config: rpcConfig,
        factory: factoryFor({
          "rpc-test-a": client(),
          "rpc-test-b": client(),
        }),
      }),
    ).toThrow(EvmChainAdapterError);
  });

  it("requires at least two distinct operators", () => {
    expect(() =>
      resolveChainProviderClients({
        chainId: chainRecord.chainId,
        rpcProviders: [
          references[0],
          { providerId: "rpc-test-b", operatorId: "operator-a" },
        ],
        config: rpcConfig,
        factory: factoryFor({
          "rpc-test-a": client(),
          "rpc-test-b": client(),
        }),
      }),
    ).toThrow(EvmChainAdapterError);
  });
});

describe("EvmChainAdapter init chain identity verification", () => {
  it("accepts agreement on the expected numeric chain id", async () => {
    const service = adapter({ "rpc-test-a": client(), "rpc-test-b": client() });
    await expect(service.init()).resolves.toBeUndefined();
  });

  it("rejects when providers report different chain ids", async () => {
    const service = adapter({
      "rpc-test-a": client(),
      "rpc-test-b": client({ getChainId: () => Promise.resolve(1) }),
    });
    await expect(service.init()).rejects.toThrow("disagree on chain identity");
  });

  it("rejects when the reported chain id does not match the registry", async () => {
    const service = adapter(
      {
        "rpc-test-a": client({ getChainId: () => Promise.resolve(1) }),
        "rpc-test-b": client({ getChainId: () => Promise.resolve(1) }),
      },
      11155111,
    );
    await expect(service.init()).rejects.toThrow("expected 11155111");
  });

  it("fails closed when a provider is unreachable during init", async () => {
    const service = adapter({
      "rpc-test-a": client({ getChainId: () => Promise.reject(new Error("offline")) }),
      "rpc-test-b": client(),
    });
    await expect(service.init()).rejects.toThrow("provider unavailable");
  });
});

describe("EvmChainAdapter failover", () => {
  it("serves from the active provider while healthy", async () => {
    const service = adapter({
      "rpc-test-a": client({ getBlockNumber: () => Promise.resolve(42n) }),
      "rpc-test-b": client({ getBlockNumber: () => Promise.resolve(99n) }),
    });
    await expect(service.getCurrentBlock()).resolves.toBe(42);
    expect(service.failoverCount).toBe(0);
  });

  it("fails over to the next provider after repeated failures", async () => {
    const service = adapter({
      "rpc-test-a": client({
        getBlockNumber: () => Promise.reject(new Error("flaky")),
      }),
      "rpc-test-b": client({ getBlockNumber: () => Promise.resolve(7n) }),
    });
    // Two consecutive failures mark the active provider unhealthy; the call
    // itself still fails that round, and the next call succeeds on the
    // failover target.
    await expect(service.getCurrentBlock()).rejects.toThrow("flaky");
    expect(service.failoverCount).toBe(1);
    await expect(service.getCurrentBlock()).resolves.toBe(7);
    expect(service.failoverCount).toBe(1);
  });

  it("surfaces the underlying error when no provider can serve the call", async () => {
    const service = adapter({
      "rpc-test-a": client({
        getBlockNumber: () => Promise.reject(new Error("down-a")),
      }),
      "rpc-test-b": client({
        getBlockNumber: () => Promise.reject(new Error("down-b")),
      }),
    });
    await expect(service.getCurrentBlock()).rejects.toThrow("down-");
  });

  it("computes confirmations from receipt and head", async () => {
    const service = adapter({
      "rpc-test-a": client({
        getBlockNumber: () => Promise.resolve(105n),
        getTransactionReceipt: () =>
          Promise.resolve({ blockNumber: 100, blockHash: `0x${"a".repeat(64)}` }),
      }),
      "rpc-test-b": client(),
    });
    await expect(service.getConfirmations(`0x${"3".repeat(64)}`)).resolves.toBe(6);
  });

  it("reports zero confirmations for a missing receipt", async () => {
    const service = adapter({
      "rpc-test-a": client({ getTransactionReceipt: () => Promise.resolve(undefined) }),
      "rpc-test-b": client(),
    });
    await expect(service.getConfirmations(`0x${"3".repeat(64)}`)).resolves.toBe(0);
  });
});

describe("EvmChainAdapter corroboration", () => {
  const header = {
    blockNumber: 100,
    blockHash: `0x${"a".repeat(64)}`,
    parentHash: `0x${"b".repeat(64)}`,
  };

  it("confirms a header through an independent provider", async () => {
    const service = adapter({
      "rpc-test-a": client(),
      "rpc-test-b": client({
        getBlockHeader: () => Promise.resolve({ ...header }),
      }),
    });
    await expect(service.corroborateBlockHeader(header)).resolves.toBe("agreeing");
  });

  it("reports disagreement when the independent provider sees another hash", async () => {
    const service = adapter({
      "rpc-test-a": client(),
      "rpc-test-b": client({
        getBlockHeader: () =>
          Promise.resolve({ ...header, blockHash: `0x${"f".repeat(64)}` }),
      }),
    });
    await expect(service.corroborateBlockHeader(header)).resolves.toBe("disagreement");
  });

  it("reports unavailable when the independent provider cannot answer", async () => {
    const service = adapter({
      "rpc-test-a": client(),
      "rpc-test-b": client({
        getBlockHeader: () => Promise.reject(new Error("offline")),
      }),
    });
    await expect(service.corroborateBlockHeader(header)).resolves.toBe("unavailable");
  });

  it("never corroborates a header with itself as the independent source", async () => {
    const service = adapter({
      "rpc-test-a": client(),
      "rpc-test-b": client({
        getBlockHeader: () => Promise.reject(new Error("offline")),
      }),
    });
    // Only rpc-test-b is independent of the active provider rpc-test-a; its
    // failure must not fall back to re-asking the active provider.
    await expect(service.corroborateBlockHeader(header)).resolves.toBe("unavailable");
  });
});

describe("decodeTransferLog", () => {
  it("decodes a canonical transfer into normalized fields", () => {
    expect(decodeTransferLog(transferEntry())).toEqual({
      fromAddress: `0x${"1".repeat(40)}`,
      toAddress: `0x${"2".repeat(40)}`,
      amount: "1",
    });
  });

  it("decodes large amounts exactly through bigint", () => {
    const entry = transferEntry({
      data: `0x${(10n ** 21n).toString(16).padStart(64, "0")}`,
    });
    expect(decodeTransferLog(entry)?.amount).toBe("1000000000000000000000");
  });

  it("rejects logs that are not a canonical two-topic transfer", () => {
    const wrongTopic0 = transferEntry({
      topics: [`0x${"e".repeat(64)}`, fromTopic, toTopic],
    });
    const tooFewTopics = transferEntry({ topics: [erc20TransferTopic, fromTopic] });
    const badAddressTopic = transferEntry({
      topics: [erc20TransferTopic, "0x12", toTopic],
    });
    expect(decodeTransferLog(wrongTopic0)).toBeUndefined();
    expect(decodeTransferLog(tooFewTopics)).toBeUndefined();
    expect(decodeTransferLog(badAddressTopic)).toBeUndefined();
  });

  it("rejects logs with malformed data words", () => {
    const shortData = transferEntry({ data: "0x01" });
    const oddData = transferEntry({ data: `0x${"g".repeat(64)}` });
    expect(decodeTransferLog(shortData)).toBeUndefined();
    expect(decodeTransferLog(oddData)).toBeUndefined();
  });
});
