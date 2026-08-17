import pino from "pino";
import { ContractFunctionRevertedError } from "viem";
import { describe, expect, it } from "vitest";

import {
  EvmDecimalGuard,
  type DecimalGuardOutcome,
} from "../../../src/infrastructure/chain/decimal-guard.js";
import type { ResolvedProviderClient } from "../../../src/infrastructure/chain/evm-chain-adapter.js";
import type { EvmProviderClient } from "../../../src/infrastructure/chain/evm-registry-verifier.js";

const logger = pino({ level: "silent" });
const contractAddress = "0x1111111111111111111111111111111111111111";

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
    getTransactionReceipt: () =>
      Promise.resolve({ blockNumber: 100, blockHash: `0x${"a".repeat(64)}` }),
    getBlockTransactions: () => Promise.resolve([]),
    readErc20Balance: () => Promise.resolve(0n),
    readErc20Decimals: () => Promise.resolve(6),
    readNativeBalance: () => Promise.resolve(0n),
    ...overrides,
  };
}

function provider(overrides: Partial<EvmProviderClient> = {}): ResolvedProviderClient {
  return {
    reference: { providerId: "rpc-test-a", operatorId: "operator-a" },
    client: client(overrides),
  };
}

function guard(providers: readonly ResolvedProviderClient[]): {
  verify: (expected: number) => Promise<DecimalGuardOutcome>;
} {
  const instance = new EvmDecimalGuard(providers, logger);
  return {
    verify: (expected: number) => instance.verifyDecimals(contractAddress, expected),
  };
}

describe("EVM decimal guard", () => {
  it("verifies matching decimals through both providers at the shared block", async () => {
    const reads: bigint[][] = [];
    const tracked = (block: bigint) =>
      client({
        getBlockNumber: () => Promise.resolve(block),
        readErc20Decimals: (address, readBlock) => {
          (reads[Number(readBlock)] ??= []).push(readBlock);
          return Promise.resolve(6);
        },
      });
    const instance = new EvmDecimalGuard(
      [
        { reference: { providerId: "a", operatorId: "op-a" }, client: tracked(100n) },
        { reference: { providerId: "b", operatorId: "op-b" }, client: tracked(120n) },
      ],
      logger,
    );
    await expect(instance.verifyDecimals(contractAddress, 6)).resolves.toEqual({
      verified: true,
      decimals: 6,
    });
    // Every read happens at the lower provider's block.
    expect(reads[100]).toHaveLength(2);
    expect(reads[120]).toBeUndefined();
  });

  it("accepts a lowercase contract address and reports the checksummed form", async () => {
    let observed: string | undefined;
    const instance = new EvmDecimalGuard(
      [
        provider(),
        provider({
          getBytecode: (address) => {
            observed = address;
            return Promise.resolve("0x6001600055");
          },
        }),
      ],
      logger,
    );
    await expect(
      instance.verifyDecimals(contractAddress.toLowerCase(), 6),
    ).resolves.toEqual({ verified: true, decimals: 6 });
    expect(observed).toBe(contractAddress);
  });

  it.each([
    ["not-an-address", true],
    ["0x1234", true],
  ])("reports unverifiable_response for invalid address %j", async (address) => {
    const instance = new EvmDecimalGuard([provider(), provider()], logger);
    await expect(instance.verifyDecimals(address, 6)).resolves.toEqual({
      verified: false,
      reason: "unverifiable_response",
    });
  });

  it("requires at least two providers", () => {
    expect(() => new EvmDecimalGuard([provider()], logger)).toThrow(
      "at least two providers",
    );
  });

  it.each([
    ["getBlockNumber", "provider_unavailable"],
    ["getBytecode", "provider_unavailable"],
    ["readErc20Decimals", "provider_unavailable"],
  ] as const)("treats a failing %s read as %s", async (method, reason) => {
    const failing = provider({
      [method]: () => Promise.reject(new Error("offline")),
    } as Partial<EvmProviderClient>);
    await expect(guard([provider(), failing]).verify(6)).resolves.toEqual({
      verified: false,
      reason,
    });
  });

  it("treats empty bytecode on any provider as metadata_missing", async () => {
    await expect(
      guard([
        provider(),
        provider({ getBytecode: () => Promise.resolve("0x") }),
      ]).verify(6),
    ).resolves.toEqual({ verified: false, reason: "metadata_missing" });
    await expect(
      guard([
        provider(),
        provider({ getBytecode: () => Promise.resolve(undefined) }),
      ]).verify(6),
    ).resolves.toEqual({ verified: false, reason: "metadata_missing" });
  });

  it("reports provider_disagreement when decimals differ between providers", async () => {
    await expect(
      guard([
        provider(),
        provider({ readErc20Decimals: () => Promise.resolve(18) }),
      ]).verify(6),
    ).resolves.toEqual({ verified: false, reason: "provider_disagreement" });
  });

  it("reports decimal_mismatch when live decimals differ from the registry", async () => {
    await expect(
      guard([
        provider({ readErc20Decimals: () => Promise.resolve(18) }),
        provider({ readErc20Decimals: () => Promise.resolve(18) }),
      ]).verify(6),
    ).resolves.toEqual({ verified: false, reason: "decimal_mismatch" });
  });

  it("reports unverifiable_response for a non-standard contract revert", async () => {
    await expect(
      guard([
        provider(),
        provider({
          readErc20Decimals: () =>
            Promise.reject(
              new ContractFunctionRevertedError({ abi: [], functionName: "decimals" }),
            ),
        }),
      ]).verify(6),
    ).resolves.toEqual({ verified: false, reason: "unverifiable_response" });
  });

  it("distinguishes non-standard contract errors from transport failures", async () => {
    await expect(
      guard([
        provider(),
        provider({
          readErc20Decimals: () => Promise.reject(new Error("ECONNRESET")),
        }),
      ]).verify(6),
    ).resolves.toEqual({ verified: false, reason: "provider_unavailable" });
  });
});
