import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Connection } from "mongoose";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../src/interfaces/http/create-app.js";
import { createPublicRegistryRouter } from "../../../src/interfaces/http/public-registry-router.js";

const logger = pino({ level: "silent" });

function fakeConnection(options: { chains: unknown[]; tokens: unknown[] }): Connection {
  const chainDocs = options.chains;
  const tokenDocs = options.tokens;
  const models: Record<string, unknown> = {};
  const connection = {
    models,
    model(name: string) {
      const existing = models[name];
      if (existing !== undefined) return existing;
      let model: unknown = {};
      if (name === "Chain") {
        model = {
          find: () => ({
            select: () => ({
              sort: () => ({ lean: () => Promise.resolve(chainDocs) }),
            }),
          }),
        };
      } else if (name === "Token") {
        model = {
          find: () => ({
            select: () => ({
              sort: () => ({ lean: () => Promise.resolve(tokenDocs) }),
            }),
          }),
        };
      }
      models[name] = model;
      return model;
    },
  } as unknown as Connection;
  return connection;
}

describe("public registry router", () => {
  let server: Server;
  let baseUrl = "";

  const chains = [
    {
      chainId: "ethereum-mainnet",
      networkFamily: "evm",
      networkChainId: 1,
      enabled: true,
      verifiedAt: new Date(),
      requiredConfirmations: 2,
      version: 1,
      rpcProviders: [
        { providerId: "rpc-a", operatorId: "operator-a" },
        { providerId: "rpc-b", operatorId: "operator-b" },
      ],
    },
  ];
  const tokens = [
    {
      tokenId: "native-ethereum-mainnet",
      chain: "ethereum-mainnet",
      assetType: "native",
      symbol: "ETH",
      decimals: 18,
      enabled: true,
      verificationStatus: "verified",
      verifiedAt: new Date(),
    },
    {
      tokenId: "token-usdc-mainnet",
      chain: "ethereum-mainnet",
      assetType: "erc20",
      symbol: "USDC",
      decimals: 6,
      contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      enabled: true,
      verificationStatus: "verified",
      verifiedAt: new Date(),
    },
  ];

  beforeAll(async () => {
    const app = createApp(
      logger,
      { isReady: () => Promise.resolve(true) },
      {
        apiRouters: [createPublicRegistryRouter(fakeConnection({ chains, tokens }))],
      },
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it("exposes chains and tokens without provider URLs or secrets", async () => {
    const response = await fetch(`${baseUrl}/api/v1/registry`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      chains: { chainId: string; networkChainId: number }[];
      tokens: { tokenId: string; symbol: string; contractAddress?: string }[];
    };
    expect(body.chains).toHaveLength(1);
    expect(body.chains[0]).toMatchObject({
      chainId: "ethereum-mainnet",
      networkChainId: 1,
    });
    expect(body.tokens).toHaveLength(2);
    expect(body.tokens.find((t) => t.tokenId === "token-usdc-mainnet")).toMatchObject({
      symbol: "USDC",
      decimals: 6,
      contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    });
    expect(
      body.tokens.find((t) => t.tokenId === "native-ethereum-mainnet"),
    ).not.toHaveProperty("contractAddress");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("rpc");
    expect(serialized).not.toContain("http");
  });
});
