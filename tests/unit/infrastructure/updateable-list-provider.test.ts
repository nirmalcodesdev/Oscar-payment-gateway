import type { Connection } from "mongoose";
import pino from "pino";
import { describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../../src/config/environment.js";
import { UpdateableSanctionsListProvider } from "../../../src/infrastructure/compliance/updateable-list-provider.js";

const logger = pino({ level: "silent" });

const sanctioned = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const clean = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const envSanctioned = "0xcccccccccccccccccccccccccccccccccccccccc";

function complianceConfig(
  overrides: Partial<RuntimeConfig["compliance"]> = {},
): RuntimeConfig["compliance"] {
  return {
    sanctionsStaticList: { listVersion: "env-v1", addresses: [envSanctioned] },
    screeningCacheTtlSec: 604_800,
    screeningListMaxAgeSec: 3_600,
    ...overrides,
  };
}

interface ManagedListFixture {
  listId: string;
  listVersion: string;
  status: "active" | "retired";
  ingestedAt: Date;
}

/**
 * Detached connection exposing only the two models the provider reads. The
 * memory cache holds the last loaded state so `invalidate` behavior stays
 * observable.
 */
function fakeConnection(options: {
  lists?: ManagedListFixture[];
  addresses?: Record<string, string[]>;
}): {
  connection: Connection;
  state: { lists: ManagedListFixture[]; addresses: Record<string, string[]> };
} {
  const state = {
    lists: options.lists ?? [],
    addresses: options.addresses ?? {},
  };
  const models: Record<string, unknown> = {};
  const connection = {
    models,
    model(name: string) {
      const existing = models[name];
      if (existing !== undefined) return existing;
      let model: unknown = {};
      if (name === "SanctionsList") {
        model = {
          findOne(query: { status?: string }) {
            const match =
              state.lists.find((list) => list.status === query.status) ?? null;
            return {
              select: () => ({
                lean: () =>
                  Promise.resolve(match && { listVersion: match.listVersion }),
              }),
              lean: () => Promise.resolve(match),
            };
          },
        };
      } else if (name === "SanctionsAddress") {
        model = {
          find(query: { listId: string }) {
            const entries = state.addresses[query.listId] ?? [];
            return {
              select: () => ({
                lean: () =>
                  Promise.resolve(
                    entries.map((normalizedAddress) => ({ normalizedAddress })),
                  ),
              }),
            };
          },
        };
      }
      models[name] = model;
      return model;
    },
  } as unknown as Connection;
  return { connection, state };
}

function provider(
  options: Parameters<typeof fakeConnection>[0],
  config?: RuntimeConfig["compliance"],
) {
  const harness = fakeConnection(options);
  return {
    harness,
    provider: new UpdateableSanctionsListProvider(
      harness.connection,
      config ?? complianceConfig(),
      logger,
    ),
  };
}

describe("UpdateableSanctionsListProvider", () => {
  it("uses the environment list when no managed list exists", async () => {
    const { provider: sut } = provider({});
    await expect(
      sut.screen({ address: envSanctioned, chain: "c" }),
    ).resolves.toMatchObject({
      verdict: "blocked",
      provider: "static-list",
      listVersion: "env-v1",
    });
    await expect(sut.screen({ address: clean, chain: "c" })).resolves.toMatchObject({
      verdict: "clear",
      provider: "static-list",
    });
  });

  it("screens against the active managed list", async () => {
    const { provider: sut } = provider({
      lists: [
        {
          listId: "sanctions_1",
          listVersion: "managed-v1",
          status: "active",
          ingestedAt: new Date(),
        },
      ],
      addresses: { sanctions_1: [sanctioned] },
    });
    await expect(
      sut.screen({ address: sanctioned, chain: "c" }),
    ).resolves.toMatchObject({
      verdict: "blocked",
      provider: "managed-list",
      listVersion: "managed-v1",
    });
    await expect(sut.screen({ address: clean, chain: "c" })).resolves.toMatchObject({
      verdict: "clear",
      provider: "managed-list",
    });
    // Mixed-case input normalizes deterministically.
    const mixedCase = `0x${sanctioned.slice(2).toUpperCase()}`;
    await expect(sut.screen({ address: mixedCase, chain: "c" })).resolves.toMatchObject(
      {
        verdict: "blocked",
      },
    );
  });

  it("fails closed when the managed list is stale", async () => {
    const { provider: sut } = provider({
      lists: [
        {
          listId: "sanctions_old",
          listVersion: "managed-v1",
          status: "active",
          ingestedAt: new Date(Date.now() - 7_200_000),
        },
      ],
      addresses: { sanctions_old: [sanctioned] },
    });
    await expect(sut.screen({ address: clean, chain: "c" })).resolves.toMatchObject({
      verdict: "unavailable",
      provider: "managed-list",
    });
  });

  it("returns indeterminate for malformed addresses", async () => {
    const { provider: sut } = provider({});
    await expect(sut.screen({ address: "0x12", chain: "c" })).resolves.toMatchObject({
      verdict: "indeterminate",
    });
  });

  it("reloads the active list after invalidation", async () => {
    const { harness, provider: sut } = provider({
      lists: [
        {
          listId: "sanctions_1",
          listVersion: "managed-v1",
          status: "active",
          ingestedAt: new Date(),
        },
      ],
      addresses: { sanctions_1: [sanctioned] },
    });
    await expect(sut.screen({ address: clean, chain: "c" })).resolves.toMatchObject({
      verdict: "clear",
    });

    // An update retires the old list and sanctions a new address set that
    // now includes the previously clean address.
    harness.state.lists = [
      {
        listId: "sanctions_2",
        listVersion: "managed-v2",
        status: "active",
        ingestedAt: new Date(),
      },
    ];
    harness.state.addresses["sanctions_2"] = [clean];
    sut.invalidate();
    await expect(sut.screen({ address: clean, chain: "c" })).resolves.toMatchObject({
      verdict: "blocked",
      listVersion: "managed-v2",
    });
  });

  it("exposes the active list version for cache invalidation", async () => {
    const { provider: sut } = provider({
      lists: [
        {
          listId: "sanctions_1",
          listVersion: "managed-v9",
          status: "active",
          ingestedAt: new Date(),
        },
      ],
      addresses: { sanctions_1: [] },
    });
    await expect(sut.activeListVersion()).resolves.toBe("managed-v9");
  });

  it("falls back to the static-list version when no managed list exists", async () => {
    const { provider: sut } = provider({});
    await expect(sut.activeListVersion()).resolves.toBe("env-v1");
  });
});
