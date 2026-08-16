import type { Connection } from "mongoose";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { ScreeningService } from "../../../src/application/compliance/screening-service.js";
import type { RuntimeConfig } from "../../../src/config/environment.js";
import type {
  SanctionsScreeningProvider,
  ScreeningResult,
} from "../../../src/domain/compliance/screening-provider.js";

const logger = pino({ level: "silent" });
const chain = "ethereum-sepolia";
const address = "0xAbCd0000000000000000000000000000000000ff";

function complianceConfig(
  overrides: Partial<RuntimeConfig["compliance"]> = {},
): RuntimeConfig["compliance"] {
  return {
    sanctionsStaticList: { listVersion: "env-v1", addresses: [] },
    screeningCacheTtlSec: 600,
    screeningListMaxAgeSec: 3_600,
    ...overrides,
  };
}

function clearResult(listVersion = "v1"): ScreeningResult {
  return {
    verdict: "clear",
    riskLevel: "clear",
    sanctioned: false,
    provider: "fake",
    listVersion,
    rawResponse: { matched: false },
  };
}

/**
 * Detached connection with an in-memory screening-record store: `findOne`
 * honors the expiry filter and `create` appends with default projections
 * (rawResponse excluded).
 */
function fakeConnection(
  options: { readonly initial?: Record<string, unknown>[] } = {},
) {
  const records: Record<string, unknown>[] = [...(options.initial ?? [])];
  const models: Record<string, unknown> = {};
  const connection = {
    models,
    model(name: string) {
      const existing = models[name];
      if (existing !== undefined) return existing;
      let model: unknown = {};
      if (name === "ComplianceScreening") {
        model = {
          findOne(query: Record<string, unknown>) {
            const matches = records.filter((record) => {
              for (const [key, value] of Object.entries(query)) {
                if (key === "expiresAt") {
                  const cutoff = (value as { $gt: Date }).$gt.getTime();
                  const expiry = (record["expiresAt"] as Date).getTime();
                  if (expiry <= cutoff) return false;
                  continue;
                }
                if (key === "verdict") {
                  if (!(key in record)) return false;
                  continue;
                }
                if (record[key] !== value) return false;
              }
              return true;
            });
            const sorted = [...matches].sort(
              (left, right) =>
                (right["checkedAt"] as Date).getTime() -
                (left["checkedAt"] as Date).getTime(),
            );
            const match = sorted[0] ?? null;
            return {
              sort: () => ({
                lean: () =>
                  Promise.resolve(
                    match === null
                      ? null
                      : (() => {
                          const rest: Record<string, unknown> = {};
                          for (const [key, value] of Object.entries(match)) {
                            if (key !== "rawResponse") rest[key] = value;
                          }
                          return rest;
                        })(),
                  ),
              }),
              lean: () => Promise.resolve(match),
            };
          },
          create(values: Record<string, unknown>) {
            records.push({ ...values });
            return Promise.resolve(values);
          },
        };
      }
      models[name] = model;
      return model;
    },
  } as unknown as Connection;
  return { connection, records };
}

function countingProvider(behavior: () => Promise<ScreeningResult>): {
  provider: SanctionsScreeningProvider & {
    activeListVersion?: () => Promise<string | undefined>;
  };
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      screen: async () => {
        calls += 1;
        return behavior();
      },
    },
  };
}

function service(connection: Connection, provider: SanctionsScreeningProvider) {
  return new ScreeningService(connection, complianceConfig(), provider, logger);
}

describe("ScreeningService cache and fail-closed behavior", () => {
  it("reuses an unexpired record and does not re-call the provider", async () => {
    const inner = countingProvider(() => Promise.resolve(clearResult()));
    const { connection } = fakeConnection({
      initial: [
        {
          screeningId: "screen_cached",
          normalizedAddress: address.toLowerCase(),
          chain,
          verdict: "blocked",
          riskLevel: "blocked",
          sanctioned: true,
          provider: "fake",
          providerVersion: "1",
          listVersion: "v1",
          checkedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 600_000),
        },
      ],
    });
    const sut = service(connection, inner.provider);
    await expect(sut.screen({ address, chain })).resolves.toMatchObject({
      verdict: "blocked",
      rawResponse: { cache: "hit", screeningId: "screen_cached" },
    });
    expect(inner.calls()).toBe(0);
  });

  it("forces a fresh call when the cache record expired", async () => {
    const inner = countingProvider(() => Promise.resolve(clearResult()));
    const { connection } = fakeConnection({
      initial: [
        {
          screeningId: "screen_expired",
          normalizedAddress: address.toLowerCase(),
          chain,
          verdict: "clear",
          riskLevel: "clear",
          sanctioned: false,
          provider: "fake",
          checkedAt: new Date(Date.now() - 1_200_000),
          expiresAt: new Date(Date.now() - 600_000),
        },
      ],
    });
    const sut = service(connection, inner.provider);
    await expect(sut.screen({ address, chain })).resolves.toMatchObject({
      verdict: "clear",
      provider: "fake",
    });
    expect(inner.calls()).toBe(1);
  });

  it("invalidates cached verdicts when the active list version changes", async () => {
    const inner = countingProvider(() => Promise.resolve(clearResult("v2")));
    const { connection } = fakeConnection({
      initial: [
        {
          screeningId: "screen_v1",
          normalizedAddress: address.toLowerCase(),
          chain,
          verdict: "clear",
          riskLevel: "clear",
          sanctioned: false,
          provider: "fake",
          listVersion: "v1",
          checkedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 600_000),
        },
      ],
    });
    const versionAware = {
      screen: (request: { address: string; chain: string }) =>
        inner.provider.screen(request),
      activeListVersion: () => Promise.resolve("v2"),
    };
    const sut = new ScreeningService(
      connection,
      complianceConfig(),
      versionAware,
      logger,
    );
    await expect(sut.screen({ address, chain })).resolves.toMatchObject({
      verdict: "clear",
      listVersion: "v2",
    });
    expect(inner.calls()).toBe(1);
  });

  it("maps a throwing provider to unavailable with a sanitized record", async () => {
    const inner = countingProvider(() =>
      Promise.reject(new Error("upstream secret-token leaked")),
    );
    const { connection, records } = fakeConnection();
    const sut = service(connection, inner.provider);
    await expect(sut.screen({ address, chain })).resolves.toMatchObject({
      verdict: "unavailable",
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.["verdict"]).toBe("unavailable");
    expect(JSON.stringify(records[0])).not.toContain("secret-token");
  });

  it("maps a malformed provider result to indeterminate", async () => {
    const inner = countingProvider(() =>
      Promise.resolve({
        verdict: "super-clear",
        riskLevel: "meh",
        sanctioned: "no",
        provider: "",
        rawResponse: {},
      } as unknown as ScreeningResult),
    );
    const { connection, records } = fakeConnection();
    const sut = service(connection, inner.provider);
    await expect(sut.screen({ address, chain })).resolves.toMatchObject({
      verdict: "indeterminate",
    });
    expect(records[0]?.["verdict"]).toBe("indeterminate");
  });

  it("records every provider call with verdict and list version", async () => {
    const inner = countingProvider(() => Promise.resolve(clearResult("v3")));
    const { connection, records } = fakeConnection();
    const sut = service(connection, inner.provider);
    await sut.screen({ address, chain });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      verdict: "clear",
      riskLevel: "clear",
      sanctioned: false,
      listVersion: "v3",
    });
  });
});
