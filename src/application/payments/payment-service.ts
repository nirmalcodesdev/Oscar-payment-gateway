import { createHash, randomUUID } from "node:crypto";

import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { MerchantPrincipal } from "../auth/principals.js";
import type { RuntimeConfig } from "../../config/environment.js";
import { buildEip681Uri } from "../../domain/chain/payment-uri.js";
import type {
  SanctionsScreeningProvider,
  ScreeningResult,
} from "../../domain/compliance/screening-provider.js";
import { screeningStatusForVerdict } from "../../domain/compliance/screening-provider.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { parsePositiveBaseUnits } from "../../domain/money/base-unit.js";
import { RateLimitUnavailableError } from "../../infrastructure/auth/rate-limiter.js";
import type { RedisRateLimiter } from "../../infrastructure/auth/rate-limiter.js";
import {
  canonicalAuditJson,
  appendAuditEntryInTransaction,
} from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { withRequiredTransaction } from "../../infrastructure/mongodb/transactions.js";
import {
  deriveReceivingAddress,
  maximumDerivationIndex,
} from "../../infrastructure/wallet/xpub-service.js";
import { RegistrySnapshotRepository } from "../registry/registry-service.js";

const idempotencyScopePrefix = "payment_create:";

export interface CreatePaymentInput {
  readonly chain: string;
  readonly token: string;
  readonly amount: string;
  readonly expiresInSec?: number | undefined;
}

export interface StoredPaymentResponse {
  readonly statusCode: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface CreatePaymentResult extends StoredPaymentResponse {
  readonly replayed: boolean;
}

function invalid(message: string): ApplicationError {
  return new ApplicationError("VALIDATION_ERROR", message, 400);
}

function notFound(): ApplicationError {
  return new ApplicationError("NOT_FOUND", "Resource not found", 404);
}

function internal(message: string, statusCode = 500): ApplicationError {
  return new ApplicationError("INTERNAL_ERROR", message, statusCode);
}

function duplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === 11_000
  );
}

export function clampExpirySec(
  requestedSec: number | undefined,
  minSec: number,
  maxSec: number,
  defaultSec: number,
): number {
  if (requestedSec === undefined) return defaultSec;
  return Math.min(Math.max(requestedSec, minSec), maxSec);
}

export function requestFingerprint(input: CreatePaymentInput): string {
  return createHash("sha256").update(canonicalAuditJson(input), "utf8").digest("hex");
}

export class PaymentService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #config: RuntimeConfig;
  readonly #rateLimiter: RedisRateLimiter;
  readonly #screening: SanctionsScreeningProvider;
  readonly #snapshots: RegistrySnapshotRepository;
  readonly #logger: Logger;

  public constructor(
    connection: Connection,
    config: RuntimeConfig,
    rateLimiter: RedisRateLimiter,
    screening: SanctionsScreeningProvider,
    logger: Logger,
  ) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#config = config;
    this.#rateLimiter = rateLimiter;
    this.#screening = screening;
    this.#snapshots = new RegistrySnapshotRepository(connection);
    this.#logger = logger;
  }

  async #consumeCreationQuota(principal: MerchantPrincipal): Promise<void> {
    const identity = createHash("sha256")
      .update(principal.credentialId, "utf8")
      .digest("hex");
    let decision;
    try {
      decision = await this.#rateLimiter.consume(
        `oscar:rate:payment-create:${identity}`,
        this.#config.payments.createRateLimitPerMinute,
        60,
      );
    } catch (error: unknown) {
      if (error instanceof RateLimitUnavailableError) {
        throw internal("Service temporarily unavailable", 503);
      }
      throw error;
    }
    if (!decision.allowed) {
      throw new ApplicationError("RATE_LIMITED", "Request rate limit exceeded", 429, {
        retryAfterSec: decision.retryAfterSec,
      });
    }
  }

  async #findIdempotencyRecord(merchantId: string, key: string) {
    return this.#models.IdempotencyKey.findOne({
      scope: `${idempotencyScopePrefix}${merchantId}`,
      key,
    }).lean();
  }

  public async createPayment(
    principal: MerchantPrincipal,
    input: CreatePaymentInput,
    idempotencyKey?: string,
  ): Promise<CreatePaymentResult> {
    await this.#consumeCreationQuota(principal);
    const fingerprint = requestFingerprint(input);
    if (idempotencyKey !== undefined) {
      const existing = await this.#findIdempotencyRecord(
        principal.merchantId,
        idempotencyKey,
      );
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new ApplicationError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was used with a different request",
            409,
          );
        }
        const stored = existing.response as StoredPaymentResponse;
        return { statusCode: stored.statusCode, body: stored.body, replayed: true };
      }
    }
    try {
      return await this.#createPayment(principal, input, fingerprint, idempotencyKey);
    } catch (error: unknown) {
      if (!duplicateKey(error) || idempotencyKey === undefined) throw error;
      const committed = await this.#findIdempotencyRecord(
        principal.merchantId,
        idempotencyKey,
      );
      if (committed === null) {
        throw new ApplicationError(
          "CONFLICT",
          "A concurrent request conflicted, retry the request",
          409,
        );
      }
      if (committed.requestFingerprint !== fingerprint) {
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was used with a different request",
          409,
        );
      }
      const stored = committed.response as StoredPaymentResponse;
      return { statusCode: stored.statusCode, body: stored.body, replayed: true };
    }
  }

  async #createPayment(
    principal: MerchantPrincipal,
    input: CreatePaymentInput,
    fingerprint: string,
    idempotencyKey: string | undefined,
  ): Promise<CreatePaymentResult> {
    const expirySec = clampExpirySec(
      input.expiresInSec,
      this.#config.payments.expiryMinSec,
      this.#config.payments.expiryMaxSec,
      this.#config.payments.expiryDefaultSec,
    );
    const amount = parsePositiveBaseUnits(input.amount);
    const created = await withRequiredTransaction(this.#connection, async (session) => {
      const snapshot = await this.#snapshots.reservePaymentConfiguration(
        input.chain,
        input.token,
        session,
      );
      if (
        amount < parsePositiveBaseUnits(snapshot.tokenMinAmount) ||
        amount > parsePositiveBaseUnits(snapshot.tokenMaxAmount)
      ) {
        throw invalid("Amount is outside the configured token bounds");
      }
      const activeMerchant = await this.#models.Merchant.exists({
        merchantId: principal.merchantId,
        status: "active",
      }).session(session);
      if (activeMerchant === null) throw notFound();

      const wallet = await this.#models.MerchantWallet.findOneAndUpdate(
        {
          merchantId: principal.merchantId,
          chain: input.chain,
          status: "active",
          nextDerivationIndex: { $lte: maximumDerivationIndex },
        },
        { $inc: { nextDerivationIndex: 1 } },
        { new: true, session, runValidators: true },
      )
        .select("+publicExtendedKey")
        .lean();
      if (wallet === null) {
        const existing = await this.#models.MerchantWallet.findOne({
          merchantId: principal.merchantId,
          chain: input.chain,
          status: "active",
        })
          .session(session)
          .lean();
        if (existing === null) {
          throw invalid("No active wallet is registered for this chain");
        }
        this.#logger.error(
          { merchantId: principal.merchantId, chain: input.chain },
          "Deposit address allocation space exhausted",
        );
        throw internal("Address allocation is unavailable", 503);
      }
      const network = this.#config.auth.walletNetworkAllowlist[input.chain];
      if (network === undefined) {
        throw invalid("Chain is not enabled for wallet onboarding");
      }
      if (typeof wallet.publicExtendedKey !== "string") {
        throw internal("Wallet key material is unavailable");
      }
      const derivationIndex = wallet.nextDerivationIndex - 1;
      const recipientAddress = deriveReceivingAddress(
        wallet.publicExtendedKey,
        network,
        derivationIndex,
      );

      let screening: ScreeningResult;
      try {
        screening = await this.#screening.screen({
          address: recipientAddress,
          chain: input.chain,
        });
      } catch (error: unknown) {
        this.#logger.error(
          { err: error, merchantId: principal.merchantId, chain: input.chain },
          "Destination screening failed closed",
        );
        throw new ApplicationError(
          "COMPLIANCE_HOLD",
          "Destination screening is unavailable",
          503,
        );
      }
      const screeningStatus = screeningStatusForVerdict(screening.verdict);

      const now = new Date();
      const paymentId = `payment_${randomUUID()}`;
      const walletAddressId = `wallet_address_${randomUUID()}`;
      const expiresAt = new Date(now.getTime() + expirySec * 1000);
      const qrCodeData = buildEip681Uri({
        networkChainId: snapshot.networkChainId,
        assetType: snapshot.tokenAssetType,
        contractAddress: snapshot.tokenContractAddress,
        recipientAddress,
        amount: input.amount,
      });

      await this.#models.WalletAddress.create(
        [
          {
            walletAddressId,
            merchantId: principal.merchantId,
            chain: input.chain,
            address: recipientAddress,
            normalizedAddress: recipientAddress.toLowerCase(),
            xpubId: wallet.xpubId,
            derivationIndex,
            assignedPaymentId: paymentId,
            status: "assigned",
            assignedAt: now,
          },
        ],
        { session },
      );
      await this.#models.Payment.create(
        [
          {
            paymentId,
            merchantId: principal.merchantId,
            chain: input.chain,
            token: input.token,
            walletAddressId,
            amount: input.amount,
            status: "pending",
            version: 0,
            requiredConfirmations: snapshot.requiredConfirmations,
            tokenVerificationPolicy: snapshot.tokenVerificationPolicy,
            confirmations: 0,
            screeningStatus,
            expiresAt,
          },
        ],
        { session },
      );
      // The screening record is written by the screening facade before this
      // transaction opens (ADR 0013); the cached verdict is reused only
      // within the TTL and the current list version.
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: `merchant_${principal.merchantId}`,
          entityType: "Payment",
          entityId: paymentId,
          action: "payment_created",
          actorType: "merchant",
          actorId: principal.merchantId,
          after: {
            status: "pending",
            amount: input.amount,
            chain: input.chain,
            token: input.token,
            screeningStatus,
            walletAddressId,
          },
          metadata: {
            screeningProvider: screening.provider,
            screeningVerdict: screening.verdict,
          },
        },
        session,
      );

      const body: Readonly<Record<string, unknown>> = {
        paymentId,
        status: "pending",
        chain: input.chain,
        token: input.token,
        amount: input.amount,
        recipientAddress,
        qrCodeData,
        expiresAt: expiresAt.toISOString(),
        createdAt: now.toISOString(),
        requiredConfirmations: snapshot.requiredConfirmations,
        screeningStatus,
      };
      if (idempotencyKey !== undefined) {
        await this.#models.IdempotencyKey.create(
          [
            {
              key: idempotencyKey,
              scope: `${idempotencyScopePrefix}${principal.merchantId}`,
              requestFingerprint: fingerprint,
              response: { statusCode: 201, body },
              createdAt: now,
              expiresAt: new Date(
                now.getTime() + this.#config.payments.idempotencyTtlSec * 1000,
              ),
            },
          ],
          { session },
        );
      }
      return body;
    });
    return { statusCode: 201, body: created, replayed: false };
  }

  public async getPayment(principal: MerchantPrincipal, paymentId: string) {
    const payment = await this.#models.Payment.findOne({
      merchantId: principal.merchantId,
      paymentId,
    }).lean();
    if (payment === null) throw notFound();
    const walletAddress = await this.#models.WalletAddress.findOne({
      merchantId: principal.merchantId,
      walletAddressId: payment.walletAddressId,
    }).lean();
    if (walletAddress === null) throw internal("Payment address is unavailable");
    const token = await this.#models.Token.findOne({ tokenId: payment.token }).lean();
    if (token === null) throw internal("Payment token registry entry is unavailable");
    const chain = await this.#models.Chain.findOne({ chainId: payment.chain }).lean();
    if (chain === null) throw internal("Payment chain registry entry is unavailable");

    const now = new Date();
    const status =
      payment.status === "pending" && payment.expiresAt <= now
        ? "expired"
        : payment.status;
    const confirmations = Math.min(
      payment.confirmations,
      payment.requiredConfirmations,
    );
    const createdAt = (payment as { createdAt?: Date }).createdAt;
    return {
      paymentId: payment.paymentId,
      status,
      chain: payment.chain,
      token: payment.token,
      amount: payment.amount,
      ...(payment.amountReceived === undefined
        ? {}
        : { amountReceived: payment.amountReceived }),
      ...(payment.partialAmountReceived === undefined
        ? {}
        : { partialAmountReceived: payment.partialAmountReceived }),
      ...(payment.excessAmount === undefined
        ? {}
        : { excessAmount: payment.excessAmount }),
      underpaymentFlag: payment.underpaymentFlag,
      overpaymentFlag: payment.overpaymentFlag,
      screeningStatus: payment.screeningStatus,
      recipientAddress: walletAddress.address,
      qrCodeData: buildEip681Uri({
        networkChainId: chain.networkChainId,
        assetType: token.assetType,
        contractAddress: token.contractAddress ?? undefined,
        recipientAddress: walletAddress.address,
        amount: payment.amount,
      }),
      expiresAt: payment.expiresAt,
      ...(createdAt === undefined ? {} : { createdAt }),
      requiredConfirmations: payment.requiredConfirmations,
      confirmations,
      confirmed: status === "confirmed",
      ...(payment.matchedAt === undefined ? {} : { matchedAt: payment.matchedAt }),
      ...(payment.confirmedAt === undefined
        ? {}
        : { confirmedAt: payment.confirmedAt }),
    };
  }
}
