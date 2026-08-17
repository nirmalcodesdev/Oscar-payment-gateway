import type { ClientSession, Connection } from "mongoose";
import { getAddress } from "viem";

import type { AdminPrincipal } from "../auth/principals.js";
import type { RuntimeConfig } from "../../config/environment.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { parsePositiveBaseUnits } from "../../domain/money/base-unit.js";
import {
  EvmRegistryVerifier,
  RegistryVerificationError,
  type RpcProviderReference,
  type TokenVerificationResult,
} from "../../infrastructure/chain/evm-registry-verifier.js";
import { appendAuditEntryInTransaction } from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { withRequiredTransaction } from "../../infrastructure/mongodb/transactions.js";

const openPaymentStatuses = ["pending", "matched", "confirming"] as const;

type VerificationPolicy = "event_only" | "balance_delta_required";

function conflict(message: string): ApplicationError {
  return new ApplicationError("CONFLICT", message, 409);
}

function notFound(): ApplicationError {
  return new ApplicationError("NOT_FOUND", "Resource not found", 404);
}

function invalid(message: string): ApplicationError {
  return new ApplicationError("VALIDATION_ERROR", message, 400);
}

function verificationFailed(): ApplicationError {
  return new ApplicationError("CHAIN_ERROR", "Registry verification failed", 502);
}

function duplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === 11_000
  );
}

function assertAmountRange(minAmount: string, maxAmount: string): void {
  if (parsePositiveBaseUnits(minAmount) > parsePositiveBaseUnits(maxAmount)) {
    throw invalid("Minimum amount must not exceed maximum amount");
  }
}

function safeChainProjection(chain: {
  chainId: string;
  networkFamily: string;
  networkChainId: number;
  name: string;
  rpcProviders: readonly { providerId: string; operatorId: string }[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  requiredConfirmations: number;
  enabled: boolean;
  version: number;
  verifiedAt?: Date | null;
}) {
  return {
    chainId: chain.chainId,
    networkFamily: chain.networkFamily,
    networkChainId: chain.networkChainId,
    name: chain.name,
    rpcProviders: chain.rpcProviders.map(({ providerId, operatorId }) => ({
      providerId,
      operatorId,
    })),
    nativeCurrency: chain.nativeCurrency,
    requiredConfirmations: chain.requiredConfirmations,
    enabled: chain.enabled,
    version: chain.version,
    ...(chain.verifiedAt == null ? {} : { verifiedAt: chain.verifiedAt }),
  };
}

function safeTokenProjection(token: {
  tokenId: string;
  chain: string;
  assetType: string;
  symbol: string;
  contractAddress?: string | null;
  decimals: number;
  minAmount: string;
  maxAmount: string;
  verificationPolicy: string;
  verificationStatus: string;
  enabled: boolean;
  version: number;
  verifiedAt?: Date | null;
  verifiedSymbol?: string | null;
  verifiedDecimals?: number | null;
  verifiedTotalSupply?: string | null;
}) {
  return {
    tokenId: token.tokenId,
    chain: token.chain,
    assetType: token.assetType,
    symbol: token.symbol,
    ...(token.contractAddress == null
      ? {}
      : { contractAddress: token.contractAddress }),
    decimals: token.decimals,
    minAmount: token.minAmount,
    maxAmount: token.maxAmount,
    verificationPolicy: token.verificationPolicy,
    verificationStatus: token.verificationStatus,
    enabled: token.enabled,
    version: token.version,
    ...(token.verifiedAt == null ? {} : { verifiedAt: token.verifiedAt }),
    ...(token.verifiedSymbol == null ? {} : { verifiedSymbol: token.verifiedSymbol }),
    ...(token.verifiedDecimals == null
      ? {}
      : { verifiedDecimals: token.verifiedDecimals }),
    ...(token.verifiedTotalSupply == null
      ? {}
      : { verifiedTotalSupply: token.verifiedTotalSupply }),
  };
}

export interface CreateChainInput {
  readonly chainId: string;
  readonly networkChainId: number;
  readonly name: string;
  readonly providerIds: readonly string[];
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly requiredConfirmations: number;
}

export interface UpdateChainInput {
  readonly expectedVersion: number;
  readonly name?: string | undefined;
  readonly providerIds?: readonly string[] | undefined;
  readonly nativeCurrency?:
    | {
        readonly name: string;
        readonly symbol: string;
        readonly decimals: number;
      }
    | undefined;
  readonly requiredConfirmations?: number | undefined;
}

export interface CreateTokenInput {
  readonly tokenId: string;
  readonly chain: string;
  readonly assetType: "erc20" | "native";
  readonly symbol: string;
  readonly contractAddress?: string | undefined;
  readonly decimals: number;
  readonly minAmount: string;
  readonly maxAmount: string;
  readonly verificationPolicy: VerificationPolicy;
}

export interface UpdateTokenInput {
  readonly expectedVersion: number;
  readonly minAmount?: string | undefined;
  readonly maxAmount?: string | undefined;
  readonly verificationPolicy?: VerificationPolicy | undefined;
}

export interface DeactivationInput {
  readonly expectedVersion: number;
  readonly force?: boolean | undefined;
  readonly confirmation?: string | undefined;
  readonly reason?: string | undefined;
}

export interface ManualReviewApproval {
  readonly acknowledged: true;
  readonly reason: string;
}

export class RegistryService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #config: RuntimeConfig;
  readonly #verifier: EvmRegistryVerifier;

  public constructor(
    connection: Connection,
    config: RuntimeConfig,
    verifier = new EvmRegistryVerifier(config.rpc),
  ) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#config = config;
    this.#verifier = verifier;
  }

  #providerReferences(providerIds: readonly string[]): RpcProviderReference[] {
    const uniqueProviderIds = new Set(providerIds);
    if (providerIds.length < 2 || uniqueProviderIds.size !== providerIds.length) {
      throw invalid("At least two distinct RPC providers are required");
    }
    const references = providerIds.map((providerId) => {
      const provider = this.#config.rpc.providers[providerId];
      if (provider === undefined) throw invalid("RPC provider selection is invalid");
      return { providerId, operatorId: provider.operatorId };
    });
    if (new Set(references.map(({ operatorId }) => operatorId)).size < 2) {
      throw invalid("RPC providers must have independent operators");
    }
    return references;
  }

  async #verifyChain(
    networkChainId: number,
    references: readonly RpcProviderReference[],
  ): Promise<void> {
    try {
      await this.#verifier.verifyChain(networkChainId, references);
    } catch (error: unknown) {
      if (error instanceof RegistryVerificationError) throw verificationFailed();
      throw error;
    }
  }

  async #verifyToken(input: {
    readonly networkChainId: number;
    readonly providerReferences: readonly RpcProviderReference[];
    readonly contractAddress: string;
    readonly decimals: number;
    readonly symbol: string;
  }): Promise<TokenVerificationResult> {
    try {
      return await this.#verifier.verifyToken({
        expectedChainId: input.networkChainId,
        providerReferences: input.providerReferences,
        contractAddress: input.contractAddress,
        expectedDecimals: input.decimals,
        expectedSymbol: input.symbol,
      });
    } catch (error: unknown) {
      if (error instanceof RegistryVerificationError) throw verificationFailed();
      throw error;
    }
  }

  public async createChain(actor: AdminPrincipal, input: CreateChainInput) {
    const rpcProviders = this.#providerReferences(input.providerIds);
    try {
      return await withRequiredTransaction(this.#connection, async (session) => {
        const [chain] = await this.#models.Chain.create(
          [
            {
              chainId: input.chainId,
              networkFamily: "evm",
              networkChainId: input.networkChainId,
              name: input.name,
              rpcProviders,
              nativeCurrency: input.nativeCurrency,
              requiredConfirmations: input.requiredConfirmations,
              enabled: false,
              version: 0,
              allocationSequence: 0,
            },
          ],
          { session },
        );
        if (chain === undefined) throw new Error("Chain creation failed");
        const result = safeChainProjection(chain.toObject());
        await appendAuditEntryInTransaction(
          this.#connection,
          {
            scope: "platform",
            entityType: "Chain",
            entityId: input.chainId,
            action: "chain_created",
            actorType: "admin",
            actorId: actor.adminId,
            after: result,
          },
          session,
        );
        return result;
      });
    } catch (error: unknown) {
      if (duplicateKey(error)) throw conflict("Chain registry entry already exists");
      throw error;
    }
  }

  public async updateChain(
    actor: AdminPrincipal,
    chainId: string,
    input: UpdateChainInput,
  ) {
    const before = await this.#models.Chain.findOne({
      chainId,
      version: input.expectedVersion,
    }).lean();
    if (before === null) throw notFound();
    const rpcProviders =
      input.providerIds === undefined
        ? before.rpcProviders.map(({ providerId, operatorId }) => ({
            providerId,
            operatorId,
          }))
        : this.#providerReferences(input.providerIds);
    if (before.enabled && input.providerIds !== undefined) {
      throw conflict("Deactivate the chain before changing RPC providers");
    }
    if (before.enabled) await this.#verifyChain(before.networkChainId, rpcProviders);
    const update = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.providerIds === undefined ? {} : { rpcProviders }),
      ...(input.nativeCurrency === undefined
        ? {}
        : { nativeCurrency: input.nativeCurrency }),
      ...(input.requiredConfirmations === undefined
        ? {}
        : { requiredConfirmations: input.requiredConfirmations }),
      ...(before.enabled ? { verifiedAt: new Date() } : {}),
    };
    return withRequiredTransaction(this.#connection, async (session) => {
      const updated = await this.#models.Chain.findOneAndUpdate(
        { chainId, version: input.expectedVersion, enabled: before.enabled },
        { $set: update, $inc: { version: 1 } },
        { new: true, session, runValidators: true },
      ).lean();
      if (updated === null) throw conflict("Chain configuration changed concurrently");
      const beforeSafe = safeChainProjection(before);
      const afterSafe = safeChainProjection(updated);
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "platform",
          entityType: "Chain",
          entityId: chainId,
          action: "chain_updated",
          actorType: "admin",
          actorId: actor.adminId,
          before: beforeSafe,
          after: afterSafe,
        },
        session,
      );
      return afterSafe;
    });
  }

  public async activateChain(
    actor: AdminPrincipal,
    chainId: string,
    expectedVersion: number,
  ) {
    const before = await this.#models.Chain.findOne({
      chainId,
      version: expectedVersion,
      enabled: false,
    }).lean();
    if (before === null) throw notFound();
    const references = before.rpcProviders.map(({ providerId, operatorId }) => ({
      providerId,
      operatorId,
    }));
    await this.#verifyChain(before.networkChainId, references);
    await this.#verifyEnabledTokensForChain(chainId, before.networkChainId, references);
    return withRequiredTransaction(this.#connection, async (session) => {
      const updated = await this.#models.Chain.findOneAndUpdate(
        { chainId, version: expectedVersion, enabled: false },
        {
          $set: { enabled: true, verifiedAt: new Date() },
          $inc: { version: 1 },
        },
        { new: true, session, runValidators: true },
      ).lean();
      if (updated === null) throw conflict("Chain configuration changed concurrently");
      const result = safeChainProjection(updated);
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "platform",
          entityType: "Chain",
          entityId: chainId,
          action: "chain_activated",
          actorType: "admin",
          actorId: actor.adminId,
          before: safeChainProjection(before),
          after: result,
        },
        session,
      );
      return result;
    });
  }

  public deactivateChain(
    actor: AdminPrincipal,
    chainId: string,
    input: DeactivationInput,
  ) {
    return this.#deactivate(actor, "Chain", chainId, input);
  }

  public async createToken(actor: AdminPrincipal, input: CreateTokenInput) {
    assertAmountRange(input.minAmount, input.maxAmount);
    const parent = await this.#models.Chain.findOne({ chainId: input.chain }).lean();
    if (parent === null) throw invalid("Token chain is not registered");
    const isNative = input.assetType === "native";
    let contractAddress: string | undefined;
    if (isNative) {
      if (input.contractAddress !== undefined) {
        throw invalid("Native tokens must not carry a contract address");
      }
      if (
        input.symbol.trim().toUpperCase() !==
        parent.nativeCurrency.symbol.trim().toUpperCase()
      ) {
        throw invalid(
          "Native token symbol must match the parent chain native currency",
        );
      }
      if (input.decimals !== parent.nativeCurrency.decimals) {
        throw invalid(
          "Native token decimals must match the parent chain native currency",
        );
      }
    } else {
      if (input.contractAddress === undefined) {
        throw invalid("ERC-20 tokens require a contract address");
      }
      try {
        contractAddress = getAddress(input.contractAddress);
      } catch {
        throw invalid("Token contract address is invalid");
      }
    }
    try {
      return await withRequiredTransaction(this.#connection, async (session) => {
        const [token] = await this.#models.Token.create(
          [
            {
              tokenId: input.tokenId,
              chain: input.chain,
              assetType: input.assetType,
              symbol: input.symbol,
              ...(contractAddress === undefined
                ? {}
                : {
                    contractAddress,
                    normalizedContractAddress: contractAddress.toLowerCase(),
                  }),
              decimals: input.decimals,
              minAmount: input.minAmount,
              maxAmount: input.maxAmount,
              verificationPolicy: input.verificationPolicy,
              enabled: false,
              verificationStatus: "unverified",
              version: 0,
              allocationSequence: 0,
            },
          ],
          { session },
        );
        if (token === undefined) throw new Error("Token creation failed");
        const result = safeTokenProjection(token.toObject());
        await appendAuditEntryInTransaction(
          this.#connection,
          {
            scope: "platform",
            entityType: "Token",
            entityId: input.tokenId,
            action: "token_created",
            actorType: "admin",
            actorId: actor.adminId,
            after: result,
          },
          session,
        );
        return result;
      });
    } catch (error: unknown) {
      if (duplicateKey(error)) throw conflict("Token registry entry already exists");
      throw error;
    }
  }

  public async updateToken(
    actor: AdminPrincipal,
    tokenId: string,
    input: UpdateTokenInput,
  ) {
    const before = await this.#models.Token.findOne({
      tokenId,
      version: input.expectedVersion,
    }).lean();
    if (before === null) throw notFound();
    const minAmount = input.minAmount ?? before.minAmount;
    const maxAmount = input.maxAmount ?? before.maxAmount;
    assertAmountRange(minAmount, maxAmount);
    if (before.enabled) {
      const chain = await this.#requireVerifiedEnabledChain(before.chain);
      if (before.assetType === "native") {
        await this.#verifyChain(chain.networkChainId, chain.rpcProviders);
      } else {
        if (before.contractAddress === undefined || before.contractAddress === null) {
          throw invalid("Token contract address is unavailable");
        }
        const verification = await this.#verifyToken({
          networkChainId: chain.networkChainId,
          providerReferences: chain.rpcProviders,
          contractAddress: before.contractAddress,
          decimals: before.decimals,
          symbol: before.symbol,
        });
        if (verification.classification !== "verified") throw verificationFailed();
      }
    }
    return withRequiredTransaction(this.#connection, async (session) => {
      const updated = await this.#models.Token.findOneAndUpdate(
        { tokenId, version: input.expectedVersion, enabled: before.enabled },
        {
          $set: {
            minAmount,
            maxAmount,
            verificationPolicy: input.verificationPolicy ?? before.verificationPolicy,
          },
          $inc: { version: 1 },
        },
        { new: true, session, runValidators: true },
      ).lean();
      if (updated === null) throw conflict("Token configuration changed concurrently");
      const result = safeTokenProjection(updated);
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "platform",
          entityType: "Token",
          entityId: tokenId,
          action: "token_updated",
          actorType: "admin",
          actorId: actor.adminId,
          before: safeTokenProjection(before),
          after: result,
        },
        session,
      );
      return result;
    });
  }

  async #requireVerifiedEnabledChain(chainId: string) {
    const chain = await this.#models.Chain.findOne({
      chainId,
      enabled: true,
      verifiedAt: { $type: "date" },
    }).lean();
    if (chain === null) throw invalid("Token chain is not active and verified");
    return {
      networkChainId: chain.networkChainId,
      rpcProviders: chain.rpcProviders.map(({ providerId, operatorId }) => ({
        providerId,
        operatorId,
      })),
    };
  }

  async #verifyEnabledTokensForChain(
    chainId: string,
    networkChainId: number,
    providerReferences: readonly RpcProviderReference[],
  ): Promise<void> {
    const tokens = await this.#models.Token.find({ chain: chainId, enabled: true })
      .sort({ tokenId: 1 })
      .lean();
    for (const token of tokens) {
      // Native tokens activate only after their parent chain is enabled (ADR 0018),
      // so none exist here yet; guard anyway for correctness.
      if (token.assetType === "native") continue;
      if (token.contractAddress === undefined || token.contractAddress === null) {
        throw verificationFailed();
      }
      const verification = await this.#verifyToken({
        networkChainId,
        providerReferences,
        contractAddress: token.contractAddress,
        decimals: token.decimals,
        symbol: token.symbol,
      });
      if (
        (token.verificationStatus === "verified" &&
          verification.classification !== "verified") ||
        (verification.classification === "manual_review" &&
          token.verificationPolicy !== "balance_delta_required")
      ) {
        throw verificationFailed();
      }
    }
  }

  /**
   * Full verification of a native token against its parent chain (ADR 0018):
   * re-Verify the chain identity through all selected providers and cross-check
   * the stored decimals against the chain's `nativeCurrency.decimals`. There is no
   * contract to call; ERC-20-only verifications bail out here.
   */
  async #verifyNativeToken(before: {
    readonly chain: string;
    readonly decimals: number;
  }): Promise<void> {
    const chain = await this.#requireVerifiedEnabledChain(before.chain);
    await this.#verifyChain(chain.networkChainId, chain.rpcProviders);
    const nativeDecimals = await this.#models.Chain.findOne({
      chainId: before.chain,
    })
      .select({ "nativeCurrency.decimals": 1 })
      .lean();
    if (nativeDecimals?.nativeCurrency.decimals !== before.decimals) {
      throw invalid("Native token decimals mismatch the parent chain");
    }
  }

  public async activateToken(
    actor: AdminPrincipal,
    tokenId: string,
    expectedVersion: number,
    manualReview?: ManualReviewApproval,
  ) {
    const before = await this.#models.Token.findOne({
      tokenId,
      version: expectedVersion,
      enabled: false,
    }).lean();
    if (before === null) throw notFound();

    if (before.assetType === "native") {
      await this.#verifyNativeToken(before);
      return withRequiredTransaction(this.#connection, async (session) => {
        const updated = await this.#models.Token.findOneAndUpdate(
          { tokenId, version: expectedVersion, enabled: false },
          {
            $set: {
              enabled: true,
              verificationStatus: "verified",
              verifiedAt: new Date(),
              verifiedSymbol: before.symbol,
              verifiedDecimals: before.decimals,
            },
            $inc: { version: 1 },
          },
          { new: true, session, runValidators: true },
        ).lean();
        if (updated === null) {
          throw conflict("Token configuration changed concurrently");
        }
        const result = safeTokenProjection(updated);
        await appendAuditEntryInTransaction(
          this.#connection,
          {
            scope: "platform",
            entityType: "Token",
            entityId: tokenId,
            action: "token_activated",
            actorType: "admin",
            actorId: actor.adminId,
            before: safeTokenProjection(before),
            after: result,
          },
          session,
        );
        return result;
      });
    }

    const chain = await this.#requireVerifiedEnabledChain(before.chain);
    if (before.contractAddress === undefined || before.contractAddress === null) {
      throw invalid("Token contract address is unavailable");
    }
    const verification = await this.#verifyToken({
      networkChainId: chain.networkChainId,
      providerReferences: chain.rpcProviders,
      contractAddress: before.contractAddress,
      decimals: before.decimals,
      symbol: before.symbol,
    });
    const manuallyApproved = verification.classification === "manual_review";
    if (manuallyApproved && manualReview === undefined) {
      return this.#recordManualReviewRequired(actor, before, verification);
    }
    if (
      manuallyApproved &&
      (before.verificationPolicy !== "balance_delta_required" ||
        manualReview?.acknowledged !== true)
    ) {
      throw invalid(
        "Non-standard tokens require balance-delta verification and explicit review",
      );
    }
    return withRequiredTransaction(this.#connection, async (session) => {
      const updated = await this.#models.Token.findOneAndUpdate(
        { tokenId, version: expectedVersion, enabled: false },
        {
          $set: {
            enabled: true,
            verificationStatus: verification.classification,
            verifiedAt: new Date(),
            verifiedSymbol: verification.symbol,
            verifiedDecimals: verification.decimals,
            verifiedTotalSupply: verification.totalSupply,
          },
          $inc: { version: 1 },
        },
        { new: true, session, runValidators: true },
      ).lean();
      if (updated === null) throw conflict("Token configuration changed concurrently");
      const result = safeTokenProjection(updated);
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "platform",
          entityType: "Token",
          entityId: tokenId,
          action: manuallyApproved
            ? "token_activated_after_manual_review"
            : "token_activated",
          actorType: "admin",
          actorId: actor.adminId,
          before: safeTokenProjection(before),
          after: result,
          metadata: {
            verificationBlock: verification.verifiedBlockNumber,
            nonStandardReads: verification.nonStandardReads,
            ...(manualReview === undefined
              ? {}
              : { reviewReason: manualReview.reason }),
          },
        },
        session,
      );
      return result;
    });
  }

  #recordManualReviewRequired(
    actor: AdminPrincipal,
    before: Parameters<typeof safeTokenProjection>[0],
    verification: TokenVerificationResult,
  ) {
    return withRequiredTransaction(this.#connection, async (session) => {
      const updated = await this.#models.Token.findOneAndUpdate(
        { tokenId: before.tokenId, version: before.version, enabled: false },
        {
          $set: {
            verificationStatus: "manual_review",
            verifiedAt: new Date(),
            verifiedSymbol: verification.symbol,
            verifiedDecimals: verification.decimals,
            verifiedTotalSupply: verification.totalSupply,
          },
          $inc: { version: 1 },
        },
        { new: true, session, runValidators: true },
      ).lean();
      if (updated === null) throw conflict("Token configuration changed concurrently");
      const result = safeTokenProjection(updated);
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "platform",
          entityType: "Token",
          entityId: before.tokenId,
          action: "token_manual_review_required",
          actorType: "admin",
          actorId: actor.adminId,
          before: safeTokenProjection(before),
          after: result,
          metadata: {
            verificationBlock: verification.verifiedBlockNumber,
            nonStandardReads: verification.nonStandardReads,
          },
        },
        session,
      );
      return result;
    });
  }

  public deactivateToken(
    actor: AdminPrincipal,
    tokenId: string,
    input: DeactivationInput,
  ) {
    return this.#deactivate(actor, "Token", tokenId, input);
  }

  #deactivate(
    actor: AdminPrincipal,
    entityType: "Chain" | "Token",
    entityId: string,
    input: DeactivationInput,
  ) {
    return withRequiredTransaction(this.#connection, async (session) => {
      const paymentFilter = {
        ...(entityType === "Chain" ? { chain: entityId } : { token: entityId }),
        status: { $in: openPaymentStatuses },
      };
      const openPaymentCount =
        await this.#models.Payment.countDocuments(paymentFilter).session(session);
      if (openPaymentCount > 0) {
        const expectedConfirmation = `DISABLE ${entityId} WITH OPEN PAYMENTS`;
        if (
          input.force !== true ||
          input.confirmation !== expectedConfirmation ||
          input.reason === undefined
        ) {
          throw conflict("Open payments block registry deactivation");
        }
      }
      let beforeSafe:
        | ReturnType<typeof safeChainProjection>
        | ReturnType<typeof safeTokenProjection>;
      let afterSafe:
        | ReturnType<typeof safeChainProjection>
        | ReturnType<typeof safeTokenProjection>;
      if (entityType === "Chain") {
        const before = await this.#models.Chain.findOne({
          chainId: entityId,
          version: input.expectedVersion,
          enabled: true,
        })
          .session(session)
          .lean();
        if (before === null) throw notFound();
        const updated = await this.#models.Chain.findOneAndUpdate(
          { chainId: entityId, version: input.expectedVersion, enabled: true },
          { $set: { enabled: false }, $inc: { version: 1 } },
          { new: true, session, runValidators: true },
        ).lean();
        if (updated === null)
          throw conflict("Registry configuration changed concurrently");
        beforeSafe = safeChainProjection(before);
        afterSafe = safeChainProjection(updated);
      } else {
        const before = await this.#models.Token.findOne({
          tokenId: entityId,
          version: input.expectedVersion,
          enabled: true,
        })
          .session(session)
          .lean();
        if (before === null) throw notFound();
        const updated = await this.#models.Token.findOneAndUpdate(
          { tokenId: entityId, version: input.expectedVersion, enabled: true },
          { $set: { enabled: false }, $inc: { version: 1 } },
          { new: true, session, runValidators: true },
        ).lean();
        if (updated === null)
          throw conflict("Registry configuration changed concurrently");
        beforeSafe = safeTokenProjection(before);
        afterSafe = safeTokenProjection(updated);
      }
      await appendAuditEntryInTransaction(
        this.#connection,
        {
          scope: "platform",
          entityType,
          entityId,
          action:
            openPaymentCount > 0
              ? `${entityType.toLowerCase()}_force_deactivated`
              : `${entityType.toLowerCase()}_deactivated`,
          actorType: "admin",
          actorId: actor.adminId,
          before: beforeSafe,
          after: afterSafe,
          metadata: {
            openPaymentCount,
            ...(openPaymentCount === 0 ? {} : { forceReason: input.reason }),
          },
        },
        session,
      );
      return afterSafe;
    });
  }
}

export interface PaymentRegistrySnapshot {
  readonly chainId: string;
  readonly tokenId: string;
  readonly tokenAssetType: "erc20" | "native";
  readonly requiredConfirmations: number;
  readonly tokenVerificationPolicy: VerificationPolicy;
  readonly chainConfigurationVersion: number;
  readonly tokenConfigurationVersion: number;
  readonly networkChainId: number;
  /** Absent for native tokens (ADR 0018). */
  readonly tokenContractAddress?: string;
  readonly tokenMinAmount: string;
  readonly tokenMaxAmount: string;
}

export class RegistrySnapshotRepository {
  readonly #models: ReturnType<typeof registerPersistenceModels>;

  public constructor(connection: Connection) {
    this.#models = registerPersistenceModels(connection);
  }

  public async reservePaymentConfiguration(
    chainId: string,
    tokenId: string,
    session: ClientSession,
  ): Promise<PaymentRegistrySnapshot> {
    const chain = await this.#models.Chain.findOneAndUpdate(
      { chainId, enabled: true, verifiedAt: { $type: "date" } },
      { $inc: { allocationSequence: 1 } },
      { new: true, session },
    ).lean();
    if (chain === null) throw invalid("Chain is not enabled and verified");
    const token = await this.#models.Token.findOneAndUpdate(
      {
        tokenId,
        chain: chainId,
        enabled: true,
        verificationStatus: { $in: ["verified", "manual_review"] },
        verifiedAt: { $type: "date" },
      },
      { $inc: { allocationSequence: 1 } },
      { new: true, session },
    ).lean();
    if (token === null) throw invalid("Token is not enabled and verified");
    return {
      chainId,
      tokenId,
      tokenAssetType: token.assetType,
      requiredConfirmations: chain.requiredConfirmations,
      tokenVerificationPolicy: token.verificationPolicy as VerificationPolicy,
      chainConfigurationVersion: chain.version,
      tokenConfigurationVersion: token.version,
      networkChainId: chain.networkChainId,
      ...(token.contractAddress === undefined || token.contractAddress === null
        ? {}
        : { tokenContractAddress: token.contractAddress }),
      tokenMinAmount: token.minAmount,
      tokenMaxAmount: token.maxAmount,
    };
  }
}
