import { createHash } from "node:crypto";

import type { Connection } from "mongoose";

import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";

/** One of a chain's configured RPC providers, as observed in the registry. */
export interface RegistryRpcProviderRecord {
  readonly providerId: string;
  readonly operatorId: string;
}

/**
 * Plain projection of an enabled, verified chain. Declared explicitly so the
 * reader's consumers never see Mongoose document types.
 */
export interface RegistryChainRecord {
  readonly chainId: string;
  readonly networkFamily: string;
  readonly networkChainId: number;
  readonly rpcProviders: readonly RegistryRpcProviderRecord[];
  readonly requiredConfirmations: number;
  readonly version: number;
  readonly verifiedAt: Date;
}

/** Plain projection of an enabled, verified token on an enabled chain. */
export interface RegistryTokenRecord {
  readonly tokenId: string;
  readonly chain: string;
  readonly assetType: "erc20" | "native";
  readonly symbol: string;
  /** Absent for native tokens (ADR 0018). */
  readonly contractAddress?: string;
  readonly normalizedContractAddress?: string;
  readonly decimals: number;
  readonly verificationPolicy: "event_only" | "balance_delta_required";
  readonly version: number;
  readonly verifiedAt: Date;
}

/** Immutable point-in-time view of the enabled registry (ADR 0009/0010). */
export interface RegistrySnapshot {
  readonly revision: string;
  readonly loadedAt: Date;
  readonly chains: readonly RegistryChainRecord[];
  readonly tokens: readonly RegistryTokenRecord[];
}

export class EnabledRegistryReader {
  readonly #models: ReturnType<typeof registerPersistenceModels>;

  public constructor(connection: Connection) {
    this.#models = registerPersistenceModels(connection);
  }

  public async refresh(): Promise<RegistrySnapshot> {
    const chainDocs = await this.#models.Chain.find({
      enabled: true,
      verifiedAt: { $type: "date" },
    })
      .select({
        chainId: 1,
        networkFamily: 1,
        networkChainId: 1,
        rpcProviders: 1,
        requiredConfirmations: 1,
        version: 1,
        verifiedAt: 1,
      })
      .sort({ chainId: 1 })
      .lean();
    const tokenDocs = await this.#models.Token.find({
      chain: { $in: chainDocs.map(({ chainId }) => chainId) },
      enabled: true,
      verificationStatus: { $in: ["verified", "manual_review"] },
      verifiedAt: { $type: "date" },
    })
      .select({
        tokenId: 1,
        chain: 1,
        assetType: 1,
        symbol: 1,
        contractAddress: 1,
        normalizedContractAddress: 1,
        decimals: 1,
        verificationPolicy: 1,
        version: 1,
        verifiedAt: 1,
      })
      .sort({ chain: 1, tokenId: 1 })
      .lean();

    // The queries above filter on `verifiedAt` dates; the guards make that
    // guarantee explicit for the type system and fail closed if it ever breaks.
    const chains: RegistryChainRecord[] = [];
    for (const doc of chainDocs) {
      if (!(doc.verifiedAt instanceof Date)) continue;
      chains.push({
        chainId: doc.chainId,
        networkFamily: doc.networkFamily,
        networkChainId: doc.networkChainId,
        rpcProviders: doc.rpcProviders.map((provider) => ({
          providerId: provider.providerId,
          operatorId: provider.operatorId,
        })),
        requiredConfirmations: doc.requiredConfirmations,
        version: doc.version,
        verifiedAt: doc.verifiedAt,
      });
    }
    const tokens: RegistryTokenRecord[] = [];
    for (const doc of tokenDocs) {
      if (!(doc.verifiedAt instanceof Date)) continue;
      tokens.push({
        tokenId: doc.tokenId,
        chain: doc.chain,
        assetType: doc.assetType,
        symbol: doc.symbol,
        ...(doc.contractAddress === undefined || doc.contractAddress === null
          ? {}
          : { contractAddress: doc.contractAddress }),
        ...(doc.normalizedContractAddress === undefined ||
        doc.normalizedContractAddress === null
          ? {}
          : { normalizedContractAddress: doc.normalizedContractAddress }),
        decimals: doc.decimals,
        verificationPolicy: doc.verificationPolicy,
        version: doc.version,
        verifiedAt: doc.verifiedAt,
      });
    }

    const revisionPayload = JSON.stringify({
      chains: chains.map(({ chainId, version }) => [chainId, version]),
      tokens: tokens.map(({ tokenId, version }) => [tokenId, version]),
    });
    return {
      revision: createHash("sha256").update(revisionPayload).digest("hex"),
      loadedAt: new Date(),
      chains,
      tokens,
    };
  }
}
