import { describe, expect, it } from "vitest";

import {
  generateMerchantApiKey,
  parseMerchantApiKey,
} from "../../../src/infrastructure/auth/merchant-api-key.js";

describe("merchant API keys", () => {
  it("generates high-entropy keys with non-secret lookup prefixes", () => {
    const generated = generateMerchantApiKey("production");

    expect(generated.key).toMatch(/^osk_live_[a-f0-9]{18}_[A-Za-z0-9_-]{43}$/);
    expect(generated.key.startsWith(`${generated.prefix}_`)).toBe(true);
    expect(parseMerchantApiKey(generated.key)).toEqual({
      key: generated.key,
      prefix: generated.prefix,
    });
  });

  it("uses test-mode prefixes outside production and rejects malformed values", () => {
    expect(generateMerchantApiKey("test").key).toMatch(/^osk_test_/);
    expect(parseMerchantApiKey("osk_live_short_secret")).toBeUndefined();
    expect(parseMerchantApiKey(undefined)).toBeUndefined();
  });
});
