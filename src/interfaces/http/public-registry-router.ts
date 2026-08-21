import { Router, type RequestHandler, type Response } from "express";
import type { Connection } from "mongoose";

import { EnabledRegistryReader } from "../../application/registry/registry-reader.js";

/**
 * Public, read-only registry surface (no authentication): exposes the enabled,
 * verified chains and tokens so external consumers (frontends, integrations)
 * can render what instruments are accepted without any admin privilege.
 * Contains no provider URLs, endpoints, or secrets — only the public registry
 * identity and monetary metadata.
 */
export function createPublicRegistryRouter(connection: Connection): Router {
  const router = Router();
  const reader = new EnabledRegistryReader(connection);

  const send: RequestHandler = async (_request, response: Response) => {
    const snapshot = await reader.refresh();
    response.status(200).json({
      chains: snapshot.chains.map((chain) => ({
        chainId: chain.chainId,
        networkChainId: chain.networkChainId,
        requiredConfirmations: chain.requiredConfirmations,
      })),
      tokens: snapshot.tokens.map((token) => ({
        tokenId: token.tokenId,
        chainId: token.chain,
        symbol: token.symbol,
        assetType: token.assetType,
        decimals: token.decimals,
        ...(token.contractAddress === undefined
          ? {}
          : { contractAddress: token.contractAddress }),
      })),
    });
  };

  router.get("/registry", send);

  return router;
}
