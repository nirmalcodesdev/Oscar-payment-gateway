import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";

import {
  deriveReceivingAddress,
  maximumDerivationIndex,
  validateXpub,
} from "../../../src/infrastructure/wallet/xpub-service.js";

const testnetVersions = { public: 0x043587cf, private: 0x04358394 } as const;
const mainnetVersions = { public: 0x0488b21e, private: 0x0488ade4 } as const;

function testnetXpub(seed: number): string {
  return HDKey.fromMasterSeed(new Uint8Array(32).fill(seed), testnetVersions)
    .publicExtendedKey;
}

function mainnetXpub(seed: number): string {
  return HDKey.fromMasterSeed(new Uint8Array(32).fill(seed), mainnetVersions)
    .publicExtendedKey;
}

describe("deriveReceivingAddress", () => {
  it("derives deterministic public-only addresses for known vectors", () => {
    const xpub = testnetXpub(6);
    expect(deriveReceivingAddress(xpub, "testnet", 0)).toBe(
      "0xC46E38c24c706e0cea851317CD8CF05a0Bd7BD05",
    );
    expect(deriveReceivingAddress(xpub, "testnet", 1)).toBe(
      "0x8f2d8D9D408E32E735a668f773945ff0237f2Ab1",
    );
    expect(deriveReceivingAddress(xpub, "testnet", 2)).toBe(
      "0x69B592F930af06Fe90d5D7ecbBe6E285B6315FCD",
    );
    expect(deriveReceivingAddress(xpub, "testnet", 0)).toBe(
      deriveReceivingAddress(xpub, "testnet", 0),
    );
  });

  it("matches the validated sample address at index zero", () => {
    const xpub = testnetXpub(6);
    expect(validateXpub(xpub, "testnet").sampleAddress).toBe(
      deriveReceivingAddress(xpub, "testnet", 0),
    );
  });

  it("derives mainnet addresses from mainnet keys", () => {
    const xpub = mainnetXpub(9);
    expect(deriveReceivingAddress(xpub, "mainnet", 0)).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("rejects private extended keys and signing material", () => {
    const xprv = HDKey.fromMasterSeed(
      new Uint8Array(32).fill(7),
      testnetVersions,
    ).privateExtendedKey;
    expect(() => deriveReceivingAddress(xprv, "testnet", 0)).toThrow(
      /public-only|format is invalid/,
    );
  });

  it("rejects a network mismatch for the submitted key", () => {
    expect(() => deriveReceivingAddress(testnetXpub(6), "mainnet", 0)).toThrow(
      /checksum or network is invalid/,
    );
  });

  it("rejects derivation indexes outside the public-only range", () => {
    const xpub = testnetXpub(6);
    for (const index of [-1, 1.5, maximumDerivationIndex + 1]) {
      expect(() => deriveReceivingAddress(xpub, "testnet", index)).toThrow(
        /public-only range/,
      );
    }
  });

  it("accepts the maximum non-hardened derivation index", () => {
    const xpub = testnetXpub(6);
    expect(deriveReceivingAddress(xpub, "testnet", maximumDerivationIndex)).toMatch(
      /^0x[0-9a-fA-F]{40}$/,
    );
  });
});
