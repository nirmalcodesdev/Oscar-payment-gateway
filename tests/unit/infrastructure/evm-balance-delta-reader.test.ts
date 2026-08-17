import pino from "pino";
import { describe, expect, it } from "vitest";

import { EvmBalanceDeltaReader } from "../../../src/infrastructure/chain/evm-balance-delta-reader.js";
import type { ResolvedProviderClient } from "../../../src/infrastructure/chain/evm-chain-adapter.js";
import type { EvmProviderClient } from "../../../src/infrastructure/chain/evm-registry-verifier.js";

const logger = pino({ level: "silent" });
const chain = "ethereum-sepolia";
const contractAddress = "0x1111111111111111111111111111111111111111";
const holder = "0x2222222222222222222222222222222222222222";

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
    getBlockHeader: () =>
      Promise.resolve({
        blockNumber: 100,
        blockHash: `0x${"a".repeat(64)}`,
        parentHash: `0x${"b".repeat(64)}`,
      }),
    getLogs: () => Promise.resolve([]),
    getTransactionReceipt: () => Promise.resolve(undefined),
    getBlockTransactions: () => Promise.resolve([]),
    readErc20Balance: () => Promise.resolve(0n),
    readErc20Decimals: () => Promise.resolve(6),
    readNativeBalance: () => Promise.resolve(0n),
    ...overrides,
  };
}

/** Provider whose balance doubles from the pre-transfer block to the transfer block. */
function providerWithBalances(
  before: bigint,
  after: bigint,
  providerId: string,
): ResolvedProviderClient {
  return {
    reference: { providerId, operatorId: `operator-${providerId}` },
    client: client({
      readErc20Balance: (_contract, _holder, blockNumber) =>
        Promise.resolve(blockNumber === 99n ? before : after),
    }),
  };
}

function reader(providers: readonly ResolvedProviderClient[]) {
  return new EvmBalanceDeltaReader(new Map([[chain, providers]]), logger);
}

const input = { chain, contractAddress, holder, blockNumber: 100 };

describe("EvmBalanceDeltaReader", () => {
  it("reports the agreed delta when independent providers agree", async () => {
    const service = reader([
      providerWithBalances(100n, 1_000n, "rpc-test-a"),
      providerWithBalances(100n, 1_000n, "rpc-test-b"),
    ]);
    await expect(service.readDelta(input)).resolves.toEqual({
      status: "agreeing",
      delta: "900",
    });
  });

  it("reads the block before the transfer and the transfer block itself", async () => {
    const readBlocks: bigint[] = [];
    const tracked = (providerId: string): ResolvedProviderClient => ({
      reference: { providerId, operatorId: `operator-${providerId}` },
      client: client({
        readErc20Balance: (_contract, _holder, blockNumber) => {
          readBlocks.push(blockNumber);
          return Promise.resolve(blockNumber === 99n ? 0n : 5n);
        },
      }),
    });
    const service = reader([tracked("rpc-test-a"), tracked("rpc-test-b")]);
    await service.readDelta(input);
    expect(readBlocks).toEqual([99n, 100n, 99n, 100n]);
  });

  it("reports disagreement when providers compute different deltas", async () => {
    const service = reader([
      providerWithBalances(0n, 1_000n, "rpc-test-a"),
      providerWithBalances(0n, 999n, "rpc-test-b"),
    ]);
    await expect(service.readDelta(input)).resolves.toEqual({ status: "disagreement" });
  });

  it("reports unavailable when any provider read fails", async () => {
    const service = reader([
      providerWithBalances(0n, 1_000n, "rpc-test-a"),
      {
        reference: { providerId: "rpc-test-b", operatorId: "operator-b" },
        client: client({
          readErc20Balance: () => Promise.reject(new Error("offline")),
        }),
      },
    ]);
    await expect(service.readDelta(input)).resolves.toEqual({ status: "unavailable" });
  });

  it("reports unavailable for unknown chains or fewer than two providers", async () => {
    const service = reader([providerWithBalances(0n, 1n, "rpc-test-a")]);
    await expect(
      service.readDelta({ ...input, chain: "bitcoin-mainnet" }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(service.readDelta(input)).resolves.toEqual({ status: "unavailable" });
  });

  it("reports unavailable for invalid addresses", async () => {
    const service = reader([
      providerWithBalances(0n, 1n, "rpc-test-a"),
      providerWithBalances(0n, 1n, "rpc-test-b"),
    ]);
    await expect(
      service.readDelta({ ...input, contractAddress: "not-an-address" }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(service.readDelta({ ...input, holder: "0x1234" })).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("reports unavailable at block zero where no previous block exists", async () => {
    const service = reader([
      providerWithBalances(0n, 1n, "rpc-test-a"),
      providerWithBalances(0n, 1n, "rpc-test-b"),
    ]);
    await expect(service.readDelta({ ...input, blockNumber: 0 })).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("reports negative deltas exactly; judgment is upstream", async () => {
    const service = reader([
      providerWithBalances(1_000n, 100n, "rpc-test-a"),
      providerWithBalances(1_000n, 100n, "rpc-test-b"),
    ]);
    await expect(service.readDelta(input)).resolves.toEqual({
      status: "agreeing",
      delta: "-900",
    });
  });

  it("swaps the provider map atomically after a registry refresh", async () => {
    const service = reader([]);
    await expect(service.readDelta(input)).resolves.toEqual({ status: "unavailable" });
    service.setProvidersByChain(
      new Map([
        [
          chain,
          [
            providerWithBalances(0n, 50n, "rpc-test-a"),
            providerWithBalances(0n, 50n, "rpc-test-b"),
          ],
        ],
      ]),
    );
    await expect(service.readDelta(input)).resolves.toEqual({
      status: "agreeing",
      delta: "50",
    });
  });
});
