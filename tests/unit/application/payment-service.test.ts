import { describe, expect, it } from "vitest";

import {
  clampExpirySec,
  requestFingerprint,
} from "../../../src/application/payments/payment-service.js";

describe("clampExpirySec", () => {
  it("returns the configured default when no expiry is requested", () => {
    expect(clampExpirySec(undefined, 300, 7200, 900)).toBe(900);
  });

  it("clamps requested values into the configured range", () => {
    expect(clampExpirySec(1, 300, 7200, 900)).toBe(300);
    expect(clampExpirySec(299, 300, 7200, 900)).toBe(300);
    expect(clampExpirySec(7201, 300, 7200, 900)).toBe(7200);
    expect(clampExpirySec(1_000_000, 300, 7200, 900)).toBe(7200);
  });

  it("keeps in-range requested values unchanged", () => {
    expect(clampExpirySec(300, 300, 7200, 900)).toBe(300);
    expect(clampExpirySec(3600, 300, 7200, 900)).toBe(3600);
    expect(clampExpirySec(7200, 300, 7200, 900)).toBe(7200);
  });
});

describe("requestFingerprint", () => {
  const input = { chain: "ethereum-sepolia", token: "usdc", amount: "1000" };

  it("is stable for identical validated bodies", () => {
    expect(requestFingerprint(input)).toBe(requestFingerprint({ ...input }));
  });

  it("does not depend on object key order", () => {
    const reordered = { amount: "1000", token: "usdc", chain: "ethereum-sepolia" };
    expect(requestFingerprint(reordered)).toBe(requestFingerprint(input));
  });

  it("changes when any business field changes", () => {
    const base = requestFingerprint(input);
    expect(requestFingerprint({ ...input, amount: "1001" })).not.toBe(base);
    expect(requestFingerprint({ ...input, chain: "ethereum-mainnet" })).not.toBe(base);
    expect(requestFingerprint({ ...input, token: "other" })).not.toBe(base);
    expect(requestFingerprint({ ...input, expiresInSec: 900 })).not.toBe(base);
  });

  it("is a lowercase sha256 hex digest", () => {
    expect(requestFingerprint(input)).toMatch(/^[0-9a-f]{64}$/);
  });
});
