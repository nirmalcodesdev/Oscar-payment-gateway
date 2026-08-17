import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/environment.js";
import {
  EvmRegistryVerifier,
  type EvmProviderClient,
  type EvmProviderClientFactory,
  type RegistryVerificationError,
} from "../../../src/infrastructure/chain/evm-registry-verifier.js";
import { validEnvironment } from "../../helpers/environment.js";

const contractAddress = "0x1111111111111111111111111111111111111111";
const references = [
  { providerId: "rpc-test-a", operatorId: "operator-a" },
  { providerId: "rpc-test-b", operatorId: "operator-b" },
] as const;

function provider(overrides: Partial<EvmProviderClient> = {}): EvmProviderClient {
  return {
    getChainId: () => Promise.resolve(11155111),
    getBlockNumber: () => Promise.resolve(100n),
    getBytecode: () => Promise.resolve("0x6001600055"),
    readTokenMetadata: () =>
      Promise.resolve({
        symbol: "USDC",
        decimals: 6,
        totalSupply: 1_000_000n,
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

function verifier(clients: Readonly<Record<string, EvmProviderClient>>) {
  const config = loadConfig(validEnvironment());
  const factory: EvmProviderClientFactory = {
    create(providerId) {
      const client = clients[providerId];
      if (client === undefined) throw new Error("Missing test provider");
      return client;
    },
  };
  return new EvmRegistryVerifier(config.rpc, factory);
}

function standardVerifier(
  left: EvmProviderClient = provider(),
  right: EvmProviderClient = provider(),
) {
  return verifier({ "rpc-test-a": left, "rpc-test-b": right });
}

describe("EVM registry verification", () => {
  it("verifies independent providers and standard ERC-20 metadata", async () => {
    const service = standardVerifier();
    await expect(service.verifyChain(11155111, references)).resolves.toBeUndefined();
    await expect(
      service.verifyToken({
        expectedChainId: 11155111,
        providerReferences: references,
        contractAddress,
        expectedDecimals: 6,
        expectedSymbol: "usdc",
      }),
    ).resolves.toMatchObject({
      classification: "verified",
      normalizedAddress: contractAddress,
      symbol: "USDC",
      decimals: 6,
      totalSupply: "1000000",
      verifiedBlockNumber: "100",
    });
  });

  it.each([
    [
      "wrong_chain",
      provider({ getChainId: () => Promise.resolve(1) }),
      provider({ getChainId: () => Promise.resolve(1) }),
    ],
    [
      "provider_disagreement",
      provider({ getChainId: () => Promise.resolve(1) }),
      provider({ getChainId: () => Promise.resolve(11155111) }),
    ],
    [
      "provider_unavailable",
      provider({ getChainId: () => Promise.reject(new Error("offline")) }),
      provider(),
    ],
  ] as const)("fails closed for %s chain verification", async (reason, left, right) => {
    const service = standardVerifier(left, right);
    await expect(service.verifyChain(11155111, references)).rejects.toMatchObject({
      reason,
    } satisfies Partial<RegistryVerificationError>);
  });

  it("fails closed on missing code, decimal mismatch, and metadata disagreement", async () => {
    const missing = standardVerifier(
      provider({ getBytecode: () => Promise.resolve(undefined) }),
      provider(),
    );
    await expect(
      missing.verifyToken({
        expectedChainId: 11155111,
        providerReferences: references,
        contractAddress,
        expectedDecimals: 6,
        expectedSymbol: "USDC",
      }),
    ).rejects.toMatchObject({ reason: "contract_missing" });

    const decimalMismatch = standardVerifier();
    await expect(
      decimalMismatch.verifyToken({
        expectedChainId: 11155111,
        providerReferences: references,
        contractAddress,
        expectedDecimals: 18,
        expectedSymbol: "USDC",
      }),
    ).rejects.toMatchObject({ reason: "decimal_mismatch" });

    const supplyDisagreement = standardVerifier(
      provider(),
      provider({
        readTokenMetadata: () =>
          Promise.resolve({
            symbol: "USDC",
            decimals: 6,
            totalSupply: 2_000_000n,
            nonStandard: [],
          }),
      }),
    );
    await expect(
      supplyDisagreement.verifyToken({
        expectedChainId: 11155111,
        providerReferences: references,
        contractAddress,
        expectedDecimals: 6,
        expectedSymbol: "USDC",
      }),
    ).rejects.toMatchObject({ reason: "provider_disagreement" });
  });

  it("classifies only explicit optional-read failures for manual review", async () => {
    const nonStandard = provider({
      readTokenMetadata: () =>
        Promise.resolve({
          decimals: 6,
          totalSupply: 1_000_000n,
          nonStandard: ["symbol"] as const,
        }),
    });
    const service = standardVerifier(nonStandard, nonStandard);
    await expect(
      service.verifyToken({
        expectedChainId: 11155111,
        providerReferences: references,
        contractAddress,
        expectedDecimals: 6,
        expectedSymbol: "USDC",
      }),
    ).resolves.toMatchObject({
      classification: "manual_review",
      nonStandardReads: ["symbol"],
    });
  });

  it("rejects mixed standard and non-standard provider outcomes", async () => {
    const nonStandard = provider({
      readTokenMetadata: () =>
        Promise.resolve({
          decimals: 6,
          totalSupply: 1_000_000n,
          nonStandard: ["symbol"] as const,
        }),
    });
    const service = standardVerifier(provider(), nonStandard);
    await expect(
      service.verifyToken({
        expectedChainId: 11155111,
        providerReferences: references,
        contractAddress,
        expectedDecimals: 6,
        expectedSymbol: "USDC",
      }),
    ).rejects.toMatchObject({ reason: "provider_disagreement" });
  });

  it("rejects unknown, duplicate, and same-operator provider references", async () => {
    const service = standardVerifier();
    for (const invalidReferences of [
      [{ providerId: "missing-provider", operatorId: "operator-c" }, references[1]],
      [references[0], references[0]],
      [references[0], { providerId: "rpc-test-b", operatorId: "operator-a" }],
    ]) {
      await expect(
        service.verifyChain(11155111, invalidReferences),
      ).rejects.toMatchObject({ reason: "provider_configuration" });
    }
  });
});
