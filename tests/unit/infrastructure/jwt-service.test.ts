import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/environment.js";
import { JwtService } from "../../../src/infrastructure/auth/jwt-service.js";
import { validEnvironment } from "../../helpers/environment.js";

const oldSecret = "old-admin-jwt-secret-value-for-tests-0001";
const newSecret = "new-admin-jwt-secret-value-for-tests-0002";

function authConfig(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return loadConfig(validEnvironment(overrides)).auth;
}

describe("JWT service", () => {
  it("verifies exact admin claims and accepts the configured previous key", async () => {
    const oldService = new JwtService(
      authConfig({
        ADMIN_JWT_CURRENT_KEY_ID: "old-key",
        ADMIN_JWT_CURRENT_SECRET: oldSecret,
      }),
    );
    const token = await oldService.signAdminAccess({
      adminId: "admin_123",
      sessionId: "session_123",
      tokenVersion: 4,
    });
    const rotatedService = new JwtService(
      authConfig({
        ADMIN_JWT_CURRENT_KEY_ID: "new-key",
        ADMIN_JWT_CURRENT_SECRET: newSecret,
        ADMIN_JWT_PREVIOUS_KEY_ID: "old-key",
        ADMIN_JWT_PREVIOUS_SECRET: oldSecret,
      }),
    );

    await expect(rotatedService.verifyAdminAccess(token)).resolves.toEqual({
      adminId: "admin_123",
      sessionId: "session_123",
      tokenVersion: 4,
    });
  });

  it("rejects unknown keys, wrong algorithms, issuer, and audience", async () => {
    const service = new JwtService(authConfig());
    const signedByUnknownKey = await new SignJWT({ role: "admin", tokenVersion: 0 })
      .setProtectedHeader({ alg: "HS256", kid: "unknown" })
      .setIssuer("oscar-payment-gateway")
      .setAudience("oscar-admin-api")
      .setSubject("admin_123")
      .setJti("session_123")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(newSecret));
    const wrongAlgorithm = await new SignJWT({ role: "admin", tokenVersion: 0 })
      .setProtectedHeader({ alg: "HS384", kid: "test-current-v1" })
      .setIssuer("wrong-issuer")
      .setAudience("wrong-audience")
      .setSubject("admin_123")
      .setJti("session_123")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(authConfig().adminJwtCurrentSecret));

    await expect(service.verifyAdminAccess(signedByUnknownKey)).rejects.toThrow();
    await expect(service.verifyAdminAccess(wrongAlgorithm)).rejects.toThrow();
  });

  it("binds merchant step-up tokens to merchant, credential, purpose, and jti", async () => {
    const service = new JwtService(authConfig());
    const token = await service.signMerchantStepUp("merchant_123", "credential_123");

    const claims = await service.verifyMerchantStepUp(token);
    expect(claims.merchantId).toBe("merchant_123");
    expect(claims.credentialId).toBe("credential_123");
    expect(typeof claims.jti).toBe("string");
  });
});
