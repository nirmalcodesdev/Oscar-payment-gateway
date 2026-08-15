import { randomUUID } from "node:crypto";

import type { ClientSession, Connection } from "mongoose";

import type { RuntimeConfig } from "../../config/environment.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { validateWebhookUrl } from "../../domain/security/webhook-url.js";
import type { MerchantPrincipal } from "../auth/principals.js";
import type { AuthService } from "../auth/auth-service.js";
import { hashSecret } from "../../infrastructure/auth/secret-hasher.js";
import { appendAuditEntryInTransaction } from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { withRequiredTransaction } from "../../infrastructure/mongodb/transactions.js";
import { validateXpub } from "../../infrastructure/wallet/xpub-service.js";

const defaultMerchantScopes = [
  "merchant:read",
  "merchant:payments",
  "merchant:credentials",
  "merchant:wallets",
  "merchant:webhook",
] as const;

function conflict(message: string): ApplicationError {
  return new ApplicationError("CONFLICT", message, 409);
}

function notFound(): ApplicationError {
  return new ApplicationError("NOT_FOUND", "Resource not found", 404);
}

function invalidInput(message: string): ApplicationError {
  return new ApplicationError("VALIDATION_ERROR", message, 400);
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === 11_000
  );
}

function merchantScope(merchantId: string): string {
  return `merchant_${merchantId}`;
}

interface AdminActor {
  readonly adminId: string;
}

export class MerchantService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #auth: AuthService;
  readonly #config: RuntimeConfig;

  public constructor(connection: Connection, auth: AuthService, config: RuntimeConfig) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#auth = auth;
    this.#config = config;
  }

  public async register(email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const merchantId = `merchant_${randomUUID()}`;
    try {
      return await withRequiredTransaction(this.#connection, async (session) => {
        const [merchant] = await this.#models.Merchant.create(
          [
            {
              merchantId,
              email: normalizedEmail,
              status: "pending_approval",
              version: 0,
            },
          ],
          { session },
        );
        if (merchant === undefined) throw new Error("Merchant creation failed");
        await appendAuditEntryInTransaction(
          this.#connection,
          {
            scope: merchantScope(merchantId),
            entityType: "Merchant",
            entityId: merchantId,
            action: "merchant_registered",
            actorType: "system",
            actorId: "merchant-onboarding",
            after: { status: "pending_approval" },
          },
          session,
        );
        return {
          merchantId: merchant.merchantId,
          email: merchant.email,
          status: merchant.status,
        };
      });
    } catch (error: unknown) {
      if (isDuplicateKey(error)) throw conflict("Merchant registration already exists");
      throw error;
    }
  }

  public async verifyEmail(
    actor: AdminActor,
    merchantId: string,
    expectedVersion: number,
  ) {
    return withRequiredTransaction(this.#connection, async (session) => {
      const before = await this.#models.Merchant.findOne({
        merchantId,
        status: "pending_approval",
        version: expectedVersion,
      })
        .session(session)
        .lean();
      if (before === null) throw notFound();
      const verifiedAt = new Date();
      const updated = await this.#models.Merchant.findOneAndUpdate(
        { merchantId, status: "pending_approval", version: expectedVersion },
        { $set: { emailVerifiedAt: verifiedAt }, $inc: { version: 1 } },
        { new: true, session },
      ).lean();
      if (updated === null) throw conflict("Merchant lifecycle changed concurrently");
      await this.#appendLifecycleAudit(
        session,
        actor.adminId,
        merchantId,
        "merchant_email_verified",
        before.status,
        updated.status,
        { emailVerified: true },
      );
      return {
        merchantId: updated.merchantId,
        status: updated.status,
        version: updated.version,
        emailVerifiedAt: updated.emailVerifiedAt,
      };
    });
  }

  public async approve(actor: AdminActor, merchantId: string, expectedVersion: number) {
    const generated = this.#auth.generateMerchantCredential();
    const secretHash = await hashSecret(generated.key);
    const credentialId = `credential_${randomUUID()}`;
    const approvedAt = new Date();
    const result = await withRequiredTransaction(this.#connection, async (session) => {
      const before = await this.#models.Merchant.findOne({
        merchantId,
        status: { $in: ["pending_approval", "suspended"] },
        version: expectedVersion,
        emailVerifiedAt: { $type: "date" },
      })
        .session(session)
        .lean();
      if (before === null) throw notFound();
      const updated = await this.#models.Merchant.findOneAndUpdate(
        {
          merchantId,
          status: before.status,
          version: expectedVersion,
          emailVerifiedAt: { $type: "date" },
        },
        {
          $set: { status: "active", approvedAt, approvedBy: actor.adminId },
          $inc: { version: 1 },
        },
        { new: true, session },
      ).lean();
      if (updated === null) throw conflict("Merchant lifecycle changed concurrently");
      await this.#models.MerchantCredential.create(
        [
          {
            credentialId,
            merchantId,
            prefix: generated.prefix,
            secretHash,
            scopes: defaultMerchantScopes,
            status: "active",
          },
        ],
        { session },
      );
      await this.#appendLifecycleAudit(
        session,
        actor.adminId,
        merchantId,
        "merchant_approved",
        before.status,
        updated.status,
        { credentialId, credentialPrefix: generated.prefix },
      );
      return { merchant: updated, apiKey: generated.key, credentialId };
    });
    return {
      merchantId: result.merchant.merchantId,
      status: result.merchant.status,
      version: result.merchant.version,
      credentialId: result.credentialId,
      apiKey: result.apiKey,
    };
  }

  public async changeStatus(
    actor: AdminActor,
    merchantId: string,
    expectedVersion: number,
    status: "suspended" | "rejected",
  ) {
    return withRequiredTransaction(this.#connection, async (session) => {
      const before = await this.#models.Merchant.findOne({
        merchantId,
        version: expectedVersion,
        status: { $nin: ["rejected"] },
      })
        .session(session)
        .lean();
      if (before === null) throw notFound();
      const updated = await this.#models.Merchant.findOneAndUpdate(
        { merchantId, version: expectedVersion, status: before.status },
        { $set: { status }, $inc: { version: 1 } },
        { new: true, session },
      ).lean();
      if (updated === null) throw conflict("Merchant lifecycle changed concurrently");
      await this.#models.MerchantCredential.updateMany(
        { merchantId, status: "active" },
        { $set: { status: "revoked", revokedAt: new Date() } },
        { session },
      );
      await this.#appendLifecycleAudit(
        session,
        actor.adminId,
        merchantId,
        `merchant_${status}`,
        before.status,
        updated.status,
      );
      return {
        merchantId: updated.merchantId,
        status: updated.status,
        version: updated.version,
      };
    });
  }

  async #appendLifecycleAudit(
    session: ClientSession,
    actorId: string,
    merchantId: string,
    action: string,
    beforeStatus: string,
    afterStatus: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await appendAuditEntryInTransaction(
      this.#connection,
      {
        scope: merchantScope(merchantId),
        entityType: "Merchant",
        entityId: merchantId,
        action,
        actorType: "admin",
        actorId,
        before: { status: beforeStatus },
        after: { status: afterStatus },
        ...(metadata === undefined ? {} : { metadata }),
      },
      session,
    );
  }

  public async rotateCredential(principal: MerchantPrincipal) {
    const generated = this.#auth.generateMerchantCredential();
    const secretHash = await hashSecret(generated.key);
    const replacementCredentialId = `credential_${randomUUID()}`;
    await withRequiredTransaction(this.#connection, async (session) => {
      const revoked = await this.#models.MerchantCredential.updateOne(
        {
          credentialId: principal.credentialId,
          merchantId: principal.merchantId,
          status: "active",
        },
        { $set: { status: "revoked", revokedAt: new Date() } },
        { session },
      );
      if (revoked.modifiedCount !== 1) {
        throw conflict("Credential changed concurrently");
      }
      await this.#models.MerchantCredential.create(
        [
          {
            credentialId: replacementCredentialId,
            merchantId: principal.merchantId,
            prefix: generated.prefix,
            secretHash,
            scopes: principal.scopes,
            status: "active",
          },
        ],
        { session },
      );
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: merchantScope(principal.merchantId),
          entityType: "MerchantCredential",
          entityId: principal.credentialId,
          action: "credential_rotated",
          actorType: "merchant",
          actorId: principal.merchantId,
          before: { status: "active", credentialId: principal.credentialId },
          after: { status: "revoked", replacementCredentialId },
          metadata: { replacementPrefix: generated.prefix },
        },
        session,
      );
    });
    return {
      credentialId: replacementCredentialId,
      apiKey: generated.key,
      prefix: generated.prefix,
    };
  }

  public async revokeCredential(
    principal: MerchantPrincipal,
    credentialId: string,
  ): Promise<void> {
    if (credentialId === principal.credentialId) {
      throw conflict("Rotate the active request credential instead of self-revoking");
    }
    await withRequiredTransaction(this.#connection, async (session) => {
      const revoked = await this.#models.MerchantCredential.updateOne(
        { credentialId, merchantId: principal.merchantId, status: "active" },
        { $set: { status: "revoked", revokedAt: new Date() } },
        { session },
      );
      if (revoked.modifiedCount !== 1) throw notFound();
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: merchantScope(principal.merchantId),
          entityType: "MerchantCredential",
          entityId: credentialId,
          action: "credential_revoked",
          actorType: "merchant",
          actorId: principal.merchantId,
          before: { status: "active" },
          after: { status: "revoked" },
        },
        session,
      );
    });
  }

  public async updateWebhook(
    principal: MerchantPrincipal,
    expectedVersion: number,
    webhookUrl: string,
  ) {
    let normalizedUrl: string;
    try {
      normalizedUrl = validateWebhookUrl(webhookUrl, this.#config.nodeEnv);
    } catch {
      throw invalidInput("Webhook URL is invalid");
    }
    return withRequiredTransaction(this.#connection, async (session) => {
      const before = await this.#models.Merchant.findOne({
        merchantId: principal.merchantId,
        status: "active",
        version: expectedVersion,
      })
        .session(session)
        .lean();
      if (before === null) throw notFound();
      const updated = await this.#models.Merchant.findOneAndUpdate(
        {
          merchantId: principal.merchantId,
          status: "active",
          version: expectedVersion,
        },
        { $set: { webhookUrl: normalizedUrl }, $inc: { version: 1 } },
        { new: true, session },
      ).lean();
      if (updated === null)
        throw conflict("Merchant configuration changed concurrently");
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: merchantScope(principal.merchantId),
          entityType: "Merchant",
          entityId: principal.merchantId,
          action: "webhook_updated",
          actorType: "merchant",
          actorId: principal.merchantId,
          before: { configured: before.webhookUrl !== undefined },
          after: { configured: true },
        },
        session,
      );
      return {
        merchantId: updated.merchantId,
        webhookUrl: updated.webhookUrl,
        version: updated.version,
      };
    });
  }

  public async registerWallet(
    principal: MerchantPrincipal,
    chain: string,
    publicExtendedKey: string,
  ) {
    return this.#writeWallet(principal, chain, publicExtendedKey);
  }

  public async rotateWallet(
    principal: MerchantPrincipal,
    currentXpubId: string,
    expectedVersion: number,
    chain: string,
    publicExtendedKey: string,
  ) {
    return this.#writeWallet(
      principal,
      chain,
      publicExtendedKey,
      currentXpubId,
      expectedVersion,
    );
  }

  async #writeWallet(
    principal: MerchantPrincipal,
    chain: string,
    publicExtendedKey: string,
    currentXpubId?: string,
    expectedVersion?: number,
  ) {
    const network = this.#config.auth.walletNetworkAllowlist[chain];
    if (network === undefined) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Chain is not enabled for wallet onboarding",
        400,
      );
    }
    const chainRecord = await this.#models.Chain.findOne({
      chainId: chain,
      enabled: true,
    })
      .select({ chainId: 1 })
      .lean();
    if (chainRecord === null) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Chain is not enabled for wallet onboarding",
        400,
      );
    }
    let validated: ReturnType<typeof validateXpub>;
    try {
      validated = validateXpub(publicExtendedKey, network);
    } catch {
      throw invalidInput("Wallet public key is invalid");
    }
    const xpubId = `xpub_${randomUUID()}`;
    await withRequiredTransaction(this.#connection, async (session) => {
      const activeMerchant = await this.#models.Merchant.exists({
        merchantId: principal.merchantId,
        status: "active",
      }).session(session);
      if (activeMerchant === null) throw notFound();
      let previousFingerprint: string | undefined;
      if (currentXpubId !== undefined && expectedVersion !== undefined) {
        const current = await this.#models.MerchantWallet.findOne({
          xpubId: currentXpubId,
          merchantId: principal.merchantId,
          chain,
          status: "active",
          version: expectedVersion,
        })
          .session(session)
          .lean();
        if (current === null) throw notFound();
        previousFingerprint = current.fingerprint;
        const retired = await this.#models.MerchantWallet.updateOne(
          {
            xpubId: currentXpubId,
            merchantId: principal.merchantId,
            chain,
            status: "active",
            version: expectedVersion,
          },
          {
            $set: { status: "retired", retiredAt: new Date() },
            $inc: { version: 1 },
          },
          { session },
        );
        if (retired.modifiedCount !== 1) throw conflict("Wallet changed concurrently");
      }
      try {
        await this.#models.MerchantWallet.create(
          [
            {
              xpubId,
              merchantId: principal.merchantId,
              chain,
              publicExtendedKey,
              fingerprint: validated.fingerprint,
              nextDerivationIndex: 0,
              status: "active",
              version: 0,
            },
          ],
          { session },
        );
      } catch (error: unknown) {
        if (isDuplicateKey(error))
          throw conflict("An active wallet already exists for this chain");
        throw error;
      }
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: merchantScope(principal.merchantId),
          entityType: "MerchantWallet",
          entityId: xpubId,
          action: currentXpubId === undefined ? "wallet_registered" : "wallet_rotated",
          actorType: "merchant",
          actorId: principal.merchantId,
          ...(currentXpubId === undefined
            ? {}
            : {
                before: {
                  xpubId: currentXpubId,
                  fingerprint: previousFingerprint,
                },
              }),
          after: { xpubId, chain, fingerprint: validated.fingerprint },
        },
        session,
      );
    });
    return {
      xpubId,
      chain,
      fingerprint: validated.fingerprint,
      sampleAddress: validated.sampleAddress,
      status: "active" as const,
      version: 0,
    };
  }
}
