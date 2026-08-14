import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { Connection } from "mongoose";

import type { RuntimeConfig } from "../../config/environment.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import {
  generateMerchantApiKey,
  parseMerchantApiKey,
} from "../../infrastructure/auth/merchant-api-key.js";
import { JwtService } from "../../infrastructure/auth/jwt-service.js";
import type { RedisRateLimiter } from "../../infrastructure/auth/rate-limiter.js";
import { hashSecret, verifySecret } from "../../infrastructure/auth/secret-hasher.js";
import { appendAuditEntryInTransaction } from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { withRequiredTransaction } from "../../infrastructure/mongodb/transactions.js";
import type { AdminPrincipal, MerchantPrincipal } from "./principals.js";

const adminLoginIpLimit = 10;
const adminLoginIdentityLimit = 5;
const merchantAuthenticationLimit = 120;
const authenticatedAdminLimit = 30;
const adminRefreshIpLimit = 20;
const adminRefreshIdentityLimit = 10;
const rateWindowSec = 60;

function unauthorized(): ApplicationError {
  return new ApplicationError("UNAUTHORIZED", "Authentication failed", 401);
}

function rateLimited(retryAfterSec: number): ApplicationError {
  return new ApplicationError("RATE_LIMITED", "Request rate limit exceeded", 429, {
    retryAfterSec,
  });
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function refreshDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeDigestMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
  );
}

function parseRefreshToken(
  value: string,
): { sessionId: string; token: string } | undefined {
  const match = /^(admin_session_[0-9a-f-]{36})\.([A-Za-z0-9_-]{64})$/.exec(value);
  if (match?.[1] === undefined) return undefined;
  return { sessionId: match[1], token: value };
}

function generateRefreshToken(): { sessionId: string; token: string } {
  const sessionId = `admin_session_${randomUUID()}`;
  return {
    sessionId,
    token: `${sessionId}.${randomBytes(48).toString("base64url")}`,
  };
}

export interface AdminTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresInSec: number;
  readonly refreshExpiresAt: Date;
}

export class AuthService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #config: RuntimeConfig;
  readonly #jwt: JwtService;
  readonly #rateLimiter: RedisRateLimiter;
  #dummyHash: Promise<string> | undefined;

  public constructor(
    connection: Connection,
    rateLimiter: RedisRateLimiter,
    config: RuntimeConfig,
  ) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#config = config;
    this.#jwt = new JwtService(config.auth);
    this.#rateLimiter = rateLimiter;
  }

  async #getDummyHash(): Promise<string> {
    this.#dummyHash ??= hashSecret("invalid-credential-placeholder");
    return this.#dummyHash;
  }

  public async authenticateMerchant(
    rawKey: unknown,
    remoteAddress: string,
  ): Promise<MerchantPrincipal> {
    const parsed = parseMerchantApiKey(rawKey);
    const rateIdentity = parsed?.prefix ?? remoteAddress;
    const decision = await this.#rateLimiter.consume(
      `oscar:rate:merchant-auth:${hashIdentifier(rateIdentity)}`,
      merchantAuthenticationLimit,
      rateWindowSec,
    );
    if (!decision.allowed) throw rateLimited(decision.retryAfterSec);

    const credential =
      parsed === undefined
        ? null
        : await this.#models.MerchantCredential.findOne({
            prefix: parsed.prefix,
            status: "active",
          })
            .select("+secretHash")
            .lean();
    const encodedHash = credential?.secretHash ?? (await this.#getDummyHash());
    const verified = await verifySecret(parsed?.key ?? "invalid", encodedHash);
    if (
      !verified ||
      credential === null ||
      (credential.expiresAt != null && credential.expiresAt <= new Date())
    ) {
      throw unauthorized();
    }
    const merchant = await this.#models.Merchant.findOne({
      merchantId: credential.merchantId,
      status: "active",
    })
      .select({ merchantId: 1 })
      .lean();
    if (merchant === null) throw unauthorized();
    await this.#models.MerchantCredential.updateOne(
      { credentialId: credential.credentialId, status: "active" },
      { $set: { lastUsedAt: new Date() } },
    );
    return {
      kind: "merchant",
      merchantId: credential.merchantId,
      credentialId: credential.credentialId,
      scopes: credential.scopes,
    };
  }

  public requireMerchantScope(principal: MerchantPrincipal, scope: string): void {
    if (!principal.scopes.includes(scope)) {
      throw new ApplicationError("FORBIDDEN", "Operation is not permitted", 403);
    }
  }

  public async loginAdmin(
    email: string,
    password: string,
    remoteAddress: string,
  ): Promise<AdminTokenPair> {
    const normalizedEmail = email.trim().toLowerCase();
    for (const [key, limit] of [
      [`oscar:rate:admin-login-ip:${hashIdentifier(remoteAddress)}`, adminLoginIpLimit],
      [
        `oscar:rate:admin-login-id:${hashIdentifier(normalizedEmail)}`,
        adminLoginIdentityLimit,
      ],
    ] as const) {
      const decision = await this.#rateLimiter.consume(key, limit, rateWindowSec);
      if (!decision.allowed) throw rateLimited(decision.retryAfterSec);
    }

    const admin = await this.#models.AdminIdentity.findOne({ email: normalizedEmail })
      .select("+passwordHash")
      .lean();
    const encodedHash = admin?.passwordHash ?? (await this.#getDummyHash());
    const verified = await verifySecret(password, encodedHash);
    if (!verified || admin === null || admin.status !== "active") throw unauthorized();
    await this.#rateLimiter.clear(
      `oscar:rate:admin-login-id:${hashIdentifier(normalizedEmail)}`,
    );
    return this.#issueAdminSession(admin.adminId, admin.tokenVersion);
  }

  async #issueAdminSession(
    adminId: string,
    tokenVersion: number,
    familyId = `admin_family_${randomUUID()}`,
  ): Promise<AdminTokenPair> {
    const refresh = generateRefreshToken();
    const expiresAt = new Date(
      Date.now() + this.#config.auth.adminRefreshTtlSec * 1000,
    );
    await withRequiredTransaction(this.#connection, async (session) => {
      await this.#models.AdminSession.create(
        [
          {
            sessionId: refresh.sessionId,
            adminId,
            refreshTokenHash: refreshDigest(refresh.token),
            familyId,
            createdAt: new Date(),
            expiresAt,
          },
        ],
        { session },
      );
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "platform",
          entityType: "AdminAction",
          entityId: refresh.sessionId,
          action: "admin_authenticated",
          actorType: "admin",
          actorId: adminId,
          metadata: { sessionFamilyId: familyId },
        },
        session,
      );
    });
    return {
      accessToken: await this.#jwt.signAdminAccess({
        adminId,
        sessionId: refresh.sessionId,
        tokenVersion,
      }),
      refreshToken: refresh.token,
      accessExpiresInSec: this.#config.auth.adminAccessTtlSec,
      refreshExpiresAt: expiresAt,
    };
  }

  public async authenticateAdmin(
    token: string,
    remoteAddress: string,
  ): Promise<AdminPrincipal> {
    let claims;
    try {
      claims = await this.#jwt.verifyAdminAccess(token);
    } catch {
      throw unauthorized();
    }
    const decision = await this.#rateLimiter.consume(
      `oscar:rate:admin:${hashIdentifier(`${claims.adminId}:${remoteAddress}`)}`,
      authenticatedAdminLimit,
      rateWindowSec,
    );
    if (!decision.allowed) throw rateLimited(decision.retryAfterSec);
    const [admin, session] = await Promise.all([
      this.#models.AdminIdentity.findOne({
        adminId: claims.adminId,
        status: "active",
        tokenVersion: claims.tokenVersion,
      })
        .select({ adminId: 1 })
        .lean(),
      this.#models.AdminSession.findOne({
        sessionId: claims.sessionId,
        adminId: claims.adminId,
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      })
        .select({ sessionId: 1 })
        .lean(),
    ]);
    if (admin === null || session === null) throw unauthorized();
    return { kind: "admin", ...claims };
  }

  public async refreshAdmin(
    rawToken: string,
    remoteAddress: string,
  ): Promise<AdminTokenPair> {
    const parsed = parseRefreshToken(rawToken);
    for (const [key, limit] of [
      [
        `oscar:rate:admin-refresh-ip:${hashIdentifier(remoteAddress)}`,
        adminRefreshIpLimit,
      ],
      [
        `oscar:rate:admin-refresh-id:${refreshDigest(parsed?.sessionId ?? rawToken)}`,
        adminRefreshIdentityLimit,
      ],
    ] as const) {
      const decision = await this.#rateLimiter.consume(key, limit, rateWindowSec);
      if (!decision.allowed) throw rateLimited(decision.retryAfterSec);
    }
    if (parsed === undefined) throw unauthorized();
    const existing = await this.#models.AdminSession.findOne({
      sessionId: parsed.sessionId,
    })
      .select("+refreshTokenHash")
      .lean();
    if (
      existing === null ||
      !safeDigestMatch(refreshDigest(parsed.token), existing.refreshTokenHash)
    ) {
      throw unauthorized();
    }
    if (existing.revokedAt !== undefined || existing.expiresAt <= new Date()) {
      await this.#revokeAdminFamily(
        existing.adminId,
        existing.familyId,
        "refresh_reuse",
      );
      throw unauthorized();
    }

    const replacement = generateRefreshToken();
    const expiresAt = new Date(
      Date.now() + this.#config.auth.adminRefreshTtlSec * 1000,
    );
    let tokenVersion = 0;
    try {
      await withRequiredTransaction(this.#connection, async (session) => {
        const revoked = await this.#models.AdminSession.updateOne(
          {
            sessionId: existing.sessionId,
            adminId: existing.adminId,
            revokedAt: { $exists: false },
            expiresAt: { $gt: new Date() },
          },
          {
            $set: {
              revokedAt: new Date(),
              replacedBySessionId: replacement.sessionId,
            },
          },
          { session },
        );
        if (revoked.modifiedCount !== 1) throw new Error("Refresh session changed");
        const admin = await this.#models.AdminIdentity.findOne({
          adminId: existing.adminId,
          status: "active",
        })
          .session(session)
          .lean();
        if (admin === null) throw unauthorized();
        tokenVersion = admin.tokenVersion;
        await this.#models.AdminSession.create(
          [
            {
              sessionId: replacement.sessionId,
              adminId: existing.adminId,
              refreshTokenHash: refreshDigest(replacement.token),
              familyId: existing.familyId,
              createdAt: new Date(),
              expiresAt,
            },
          ],
          { session },
        );
        await appendAuditEntryInTransaction(
          this.#connection,
          {
            scope: "platform",
            entityType: "AdminAction",
            entityId: existing.sessionId,
            action: "admin_refresh_rotated",
            actorType: "admin",
            actorId: existing.adminId,
            metadata: { replacementSessionId: replacement.sessionId },
          },
          session,
        );
      });
    } catch {
      await this.#revokeAdminFamily(
        existing.adminId,
        existing.familyId,
        "refresh_race",
      );
      throw unauthorized();
    }
    return {
      accessToken: await this.#jwt.signAdminAccess({
        adminId: existing.adminId,
        sessionId: replacement.sessionId,
        tokenVersion,
      }),
      refreshToken: replacement.token,
      accessExpiresInSec: this.#config.auth.adminAccessTtlSec,
      refreshExpiresAt: expiresAt,
    };
  }

  async #revokeAdminFamily(
    adminId: string,
    familyId: string,
    reason: string,
  ): Promise<void> {
    await withRequiredTransaction(this.#connection, async (session) => {
      const now = new Date();
      await this.#models.AdminSession.updateMany(
        { adminId, familyId, revokedAt: { $exists: false } },
        { $set: { revokedAt: now } },
        { session },
      );
      await this.#models.AdminIdentity.updateOne(
        { adminId },
        { $inc: { tokenVersion: 1 } },
        { session },
      );
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "platform",
          entityType: "AdminAction",
          entityId: familyId,
          action: "admin_session_family_revoked",
          actorType: "system",
          actorId: "authentication-service",
          metadata: { reason },
        },
        session,
      );
    });
  }

  public async logoutAdmin(principal: AdminPrincipal): Promise<void> {
    await withRequiredTransaction(this.#connection, async (session) => {
      await this.#models.AdminSession.updateOne(
        {
          sessionId: principal.sessionId,
          adminId: principal.adminId,
          revokedAt: { $exists: false },
        },
        { $set: { revokedAt: new Date() } },
        { session },
      );
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "platform",
          entityType: "AdminAction",
          entityId: principal.sessionId,
          action: "admin_logged_out",
          actorType: "admin",
          actorId: principal.adminId,
        },
        session,
      );
    });
  }

  public issueMerchantStepUp(principal: MerchantPrincipal): Promise<string> {
    return this.#jwt.signMerchantStepUp(principal.merchantId, principal.credentialId);
  }

  public async consumeMerchantStepUp(
    token: string,
    principal: MerchantPrincipal,
  ): Promise<void> {
    let claims;
    try {
      claims = await this.#jwt.verifyMerchantStepUp(token);
    } catch {
      throw unauthorized();
    }
    if (
      claims.merchantId !== principal.merchantId ||
      claims.credentialId !== principal.credentialId
    ) {
      throw unauthorized();
    }
    const consumed = await this.#rateLimiter.consumeStepUp(
      claims.jti,
      this.#config.auth.merchantStepUpTtlSec,
    );
    if (!consumed) throw unauthorized();
  }

  public generateMerchantCredential() {
    return generateMerchantApiKey(this.#config.nodeEnv);
  }
}
