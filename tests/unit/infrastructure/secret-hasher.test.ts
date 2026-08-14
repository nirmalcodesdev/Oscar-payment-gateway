import { describe, expect, it } from "vitest";

import {
  hashSecret,
  scryptTestParameters,
  verifySecret,
} from "../../../src/infrastructure/auth/secret-hasher.js";

describe("secret hashing", () => {
  it("uses unique salts and verifies only the original secret", async () => {
    const first = await hashSecret(
      "correct horse battery staple",
      scryptTestParameters,
    );
    const second = await hashSecret(
      "correct horse battery staple",
      scryptTestParameters,
    );

    expect(first).not.toBe(second);
    await expect(verifySecret("correct horse battery staple", first)).resolves.toBe(
      true,
    );
    await expect(verifySecret("wrong secret", first)).resolves.toBe(false);
  });

  it("rejects malformed or policy-downgraded envelopes", async () => {
    await expect(verifySecret("secret", "not-an-envelope")).resolves.toBe(false);
    await expect(verifySecret("secret", "scrypt$v1$2$1$1$c2FsdA$aGFzaA")).resolves.toBe(
      false,
    );
  });

  it("runs the production profile within its configured memory bound", async () => {
    const encoded = await hashSecret("production-profile-test-secret");

    await expect(verifySecret("production-profile-test-secret", encoded)).resolves.toBe(
      true,
    );
  });
});
