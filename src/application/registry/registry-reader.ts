import { createHash } from "node:crypto";

import type { Connection } from "mongoose";

import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";

export class EnabledRegistryReader {
  readonly #models: ReturnType<typeof registerPersistenceModels>;

  public constructor(connection: Connection) {
    this.#models = registerPersistenceModels(connection);
  }

  public async refresh() {
    const chains = await this.#models.Chain.find({
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
    const chainIds = chains.map(({ chainId }) => chainId);
    const tokens = await this.#models.Token.find({
      chain: { $in: chainIds },
      enabled: true,
      verificationStatus: { $in: ["verified", "manual_review"] },
      verifiedAt: { $type: "date" },
    })
      .select({
        tokenId: 1,
        chain: 1,
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
