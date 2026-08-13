import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { LifecycleManager } from "../../../src/infrastructure/lifecycle/lifecycle-manager.js";
import type { ManagedResource } from "../../../src/infrastructure/lifecycle/managed-resource.js";

function resource(name: string, events: string[], ready = true) {
  const start = vi.fn(() => {
    events.push(`start:${name}`);
    return Promise.resolve();
  });
  const stop = vi.fn(() => {
    events.push(`stop:${name}`);
    return Promise.resolve();
  });
  const isReady = vi.fn(() => Promise.resolve(ready));
  const managed: ManagedResource = { name, start, stop, isReady };
  return { managed, start, stop };
}

describe("LifecycleManager", () => {
  const logger = pino({ level: "silent" });

  it("starts in declaration order and stops in reverse order", async () => {
    const events: string[] = [];
    const first = resource("first", events);
    const second = resource("second", events);
    const manager = new LifecycleManager([first.managed, second.managed], logger);

    await manager.start();
    await manager.stop();

    expect(events).toEqual([
      "start:first",
      "start:second",
      "stop:second",
      "stop:first",
    ]);
  });

  it("rolls back resources that started before a startup failure", async () => {
    const events: string[] = [];
    const first = resource("first", events);
    const failing = resource("failing", events);
    failing.start.mockRejectedValueOnce(new Error("start failed"));
    const manager = new LifecycleManager([first.managed, failing.managed], logger);

    await expect(manager.start()).rejects.toThrow("start failed");

    expect(events).toEqual(["start:first", "stop:first"]);
  });

  it("makes concurrent stop calls idempotent", async () => {
    const events: string[] = [];
    const managed = resource("only", events);
    const manager = new LifecycleManager([managed.managed], logger);
    await manager.start();

    await Promise.all([manager.stop(), manager.stop()]);

    expect(managed.stop).toHaveBeenCalledTimes(1);
  });

  it("is not ready before startup and requires every resource to be ready", async () => {
    const events: string[] = [];
    const ready = resource("ready", events);
    const unavailable = resource("unavailable", events, false);
    const manager = new LifecycleManager([ready.managed, unavailable.managed], logger);

    await expect(manager.isReady()).resolves.toBe(false);
    await manager.start();
    await expect(manager.isReady()).resolves.toBe(false);
    await manager.stop();
  });

  it("fails readiness closed when a resource throws", async () => {
    const events: string[] = [];
    const failing = resource("failing", events);
    failing.managed.isReady = vi.fn(() => Promise.reject(new Error("not ready")));
    const manager = new LifecycleManager([failing.managed], logger);
    await manager.start();

    await expect(manager.isReady()).resolves.toBe(false);
    await manager.stop();
  });

  it("attempts every stop and reports aggregate shutdown failure", async () => {
    const events: string[] = [];
    const first = resource("first", events);
    const second = resource("second", events);
    second.stop.mockRejectedValueOnce(new Error("stop failed"));
    const manager = new LifecycleManager([first.managed, second.managed], logger);
    await manager.start();

    await expect(manager.stop()).rejects.toThrow("One or more resources failed");
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
  });
});
