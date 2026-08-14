import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";

import { validateXpub } from "../../../src/infrastructure/wallet/xpub-service.js";

const mainnetVersions = { public: 0x0488b21e, private: 0x0488ade4 } as const;
const testnetVersions = { public: 0x043587cf, private: 0x04358394 } as const;

function publicKey(versions: {
  readonly public: number;
  readonly private: number;
}): string {
  return HDKey.fromMasterSeed(new Uint8Array(32).fill(7), versions).publicExtendedKey;
}

describe("wallet public extended keys", () => {
  it("validates checksum, network, derivation, and sample EVM address", () => {
    const result = validateXpub(publicKey(mainnetVersions), "mainnet");

    expect(result.network).toBe("mainnet");
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(result.sampleAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("rejects network mismatch, checksum corruption, and private extended keys", () => {
    expect(() => validateXpub(publicKey(testnetVersions), "mainnet")).toThrow();
    const xpub = publicKey(mainnetVersions);
    expect(() => validateXpub(`${xpub.slice(0, -1)}1`, "mainnet")).toThrow();
    const xprv = HDKey.fromMasterSeed(
      new Uint8Array(32).fill(9),
      mainnetVersions,
    ).privateExtendedKey;
    expect(() => validateXpub(xprv, "mainnet")).toThrow();
  });
});
