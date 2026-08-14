import { randomBytes } from "node:crypto";

import { decodeProtectedHeader, jwtVerify, SignJWT, type JWTPayload } from "jose";

import type { RuntimeConfig } from "../../config/environment.js";

const issuer = "oscar-payment-gateway";
const adminAudience = "oscar-admin-api";
const stepUpAudience = "oscar-merchant-wallet-step-up";

export interface AdminAccessClaims {
  readonly adminId: string;
  readonly sessionId: string;
  readonly tokenVersion: number;
}

export interface MerchantStepUpClaims {
  readonly merchantId: string;
  readonly credentialId: string;
  readonly jti: string;
}

function secret(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export class JwtService {
  readonly #config: RuntimeConfig["auth"];

  public constructor(config: RuntimeConfig["auth"]) {
    this.#config = config;
  }

  public async signAdminAccess(claims: AdminAccessClaims): Promise<string> {
    return new SignJWT({
      role: "admin",
      tokenVersion: claims.tokenVersion,
    })
      .setProtectedHeader({ alg: "HS256", kid: this.#config.adminJwtCurrentKeyId })
      .setIssuer(issuer)
      .setAudience(adminAudience)
      .setSubject(claims.adminId)
      .setJti(claims.sessionId)
      .setIssuedAt()
      .setExpirationTime(`${this.#config.adminAccessTtlSec}s`)
      .sign(secret(this.#config.adminJwtCurrentSecret));
  }

  public async verifyAdminAccess(token: string): Promise<AdminAccessClaims> {
    const protectedHeader = decodeProtectedHeader(token);
    if (protectedHeader.alg !== "HS256" || typeof protectedHeader.kid !== "string") {
      throw new Error("Invalid admin access token header");
    }
    const key =
      protectedHeader.kid === this.#config.adminJwtCurrentKeyId
        ? this.#config.adminJwtCurrentSecret
        : protectedHeader.kid === this.#config.adminJwtPreviousKeyId
          ? this.#config.adminJwtPreviousSecret
          : undefined;
    if (key === undefined) throw new Error("Unknown admin access token key");
    const { payload } = await jwtVerify(token, secret(key), {
      algorithms: ["HS256"],
      issuer,
      audience: adminAudience,
    });
    if (
      payload["role"] !== "admin" ||
      typeof payload.sub !== "string" ||
      typeof payload.jti !== "string" ||
      typeof payload["tokenVersion"] !== "number" ||
      !Number.isSafeInteger(payload["tokenVersion"])
    ) {
      throw new Error("Invalid admin access token claims");
    }
    return {
      adminId: payload.sub,
      sessionId: payload.jti,
      tokenVersion: payload["tokenVersion"],
    };
  }

  public async signMerchantStepUp(
    merchantId: string,
    credentialId: string,
  ): Promise<string> {
    const jti = randomBytes(24).toString("base64url");
    return new SignJWT({ merchantId, credentialId, purpose: "wallet-rotation" })
      .setProtectedHeader({ alg: "HS256", kid: "merchant-step-up-v1" })
      .setIssuer(issuer)
      .setAudience(stepUpAudience)
      .setSubject(merchantId)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(`${this.#config.merchantStepUpTtlSec}s`)
      .sign(secret(this.#config.merchantStepUpSecret));
  }

  public async verifyMerchantStepUp(token: string): Promise<MerchantStepUpClaims> {
    const { payload } = await jwtVerify(
      token,
      secret(this.#config.merchantStepUpSecret),
      {
        algorithms: ["HS256"],
        issuer,
        audience: stepUpAudience,
      },
    );
    if (
      payload["purpose"] !== "wallet-rotation" ||
      typeof payload.sub !== "string" ||
      typeof payload.jti !== "string" ||
      typeof payload["merchantId"] !== "string" ||
      typeof payload["credentialId"] !== "string"
    ) {
      throw new Error("Invalid merchant step-up claims");
    }
    return {
      merchantId: payload["merchantId"],
      credentialId: payload["credentialId"],
      jti: payload.jti,
    };
  }
}

export function isJwtPayload(value: unknown): value is JWTPayload {
  return typeof value === "object" && value !== null;
}
