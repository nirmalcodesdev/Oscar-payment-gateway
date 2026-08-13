import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ManagedResource } from "../../../src/infrastructure/lifecycle/managed-resource.js";
import { ResourceReadinessProbe } from "../../../src/infrastructure/lifecycle/readiness-probe.js";

function readinessResource(result: boolean | Error): ManagedResource {
  return {
    name: "dependency",
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => {
      if (result instanceof Error) {
        return Promise.reject(result);
      }
      return Promise.resolve(result);
    }),
  };
}

describe("ResourceReadinessProbe", () => {
  const logger = pino({ level: "silent" });

  it("is ready only when every dependency is ready", async () => {
    const probe = new ResourceReadinessProbe(
      [readinessResource(true), readinessResource(false)],
      logger,
    );

    await expect(probe.isReady()).resolves.toBe(false);
  });

  it("fails closed when a readiness check throws", async () => {
    const probe = new ResourceReadinessProbe(
      [readinessResource(new Error("dependency failed"))],
      logger,
    );

    await expect(probe.isReady()).resolves.toBe(false);
  });
});
