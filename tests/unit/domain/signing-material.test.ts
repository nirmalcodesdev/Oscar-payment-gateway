import { describe, expect, it } from "vitest";

import {
  assertNoSigningMaterial,
  containsSigningMaterial,
} from "../../../src/domain/security/signing-material.js";

describe("signing-material rejection", () => {
  it.each([
    { privateKey: `0x${"ab".repeat(32)}` },
    { publicExtendedKey: `xprv${"1".repeat(107)}` },
    {
      nested: {
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      },
    },
    { seedPhrase: "not persisted" },
    { value: "-----BEGIN PRIVATE KEY-----\nsecret" },
    { value: `K${"1".repeat(51)}` },
  ])("detects signing material before persistence", (input) => {
    expect(containsSigningMaterial(input)).toBe(true);
    expect(() => assertNoSigningMaterial(input)).toThrow("Signing material");
  });

  it("allows a public extended key field", () => {
    expect(containsSigningMaterial({ publicExtendedKey: "xpub-public-only" })).toBe(
      false,
    );
  });
});
