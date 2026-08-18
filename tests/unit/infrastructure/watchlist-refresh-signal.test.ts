import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";

import {
  signalWalletWatchlistRefresh,
  walletWatchlistRefreshChannel,
} from "../../../src/infrastructure/redis/watchlist-refresh-signal.js";

function redisStub(): { redis: Redis; publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn().mockResolvedValue(1);
  return { redis: { publish } as unknown as Redis, publish };
}

describe("watchlist refresh signal", () => {
  it("publishes to the namespaced channel", () => {
    const { redis, publish } = redisStub();
    signalWalletWatchlistRefresh(redis, "oscar");
    expect(publish).toHaveBeenCalledWith("oscar:wallet-watchlist-refresh", "refresh");
  });

  it("swallows publish rejections (best effort; timer is the fallback)", () => {
    const publish = vi.fn().mockRejectedValue(new Error("offline"));
    const redis = { publish } as unknown as Redis;
    signalWalletWatchlistRefresh(redis, "oscar");
    // The notifier always returns deferred and never throws from a failed publish.
    expect(publish).toHaveBeenCalled();
    expect(publish.mock.calls.length).toBe(1);
  });

  it("derives a deterministic channel name", () => {
    expect(walletWatchlistRefreshChannel("oscar")).toBe(
      "oscar:wallet-watchlist-refresh",
    );
  });
});
