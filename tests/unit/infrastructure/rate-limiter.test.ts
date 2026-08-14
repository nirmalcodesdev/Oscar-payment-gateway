import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";

import {
  RateLimitUnavailableError,
  RedisRateLimiter,
} from "../../../src/infrastructure/auth/rate-limiter.js";

function redisStub(methods: Partial<Record<"eval" | "del" | "set", unknown>>): Redis {
  return methods as unknown as Redis;
}

describe("Redis rate and replay controls", () => {
  it("returns atomic counter decisions and retry timing", async () => {
    const evalMock = vi.fn().mockResolvedValue([3, 42]);
    const limiter = new RedisRateLimiter(redisStub({ eval: evalMock }));

    await expect(limiter.consume("rate-key", 2, 60)).resolves.toEqual({
      allowed: false,
      count: 3,
      retryAfterSec: 42,
    });
    expect(evalMock).toHaveBeenCalledWith(expect.any(String), 1, "rate-key", 60);
  });

  it("uses SET NX for one-use step-up tokens", async () => {
    const setMock = vi.fn().mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    const limiter = new RedisRateLimiter(redisStub({ set: setMock }));

    await expect(limiter.consumeStepUp("jti-1", 300)).resolves.toBe(true);
    await expect(limiter.consumeStepUp("jti-1", 300)).resolves.toBe(false);
    expect(setMock).toHaveBeenCalledWith("oscar:step-up:jti-1", "1", "EX", 300, "NX");
  });

  it("fails closed when Redis is unavailable or returns malformed data", async () => {
    const unavailable = new RedisRateLimiter(
      redisStub({ eval: vi.fn().mockRejectedValue(new Error("offline")) }),
    );
    const malformed = new RedisRateLimiter(
      redisStub({ eval: vi.fn().mockResolvedValue("invalid") }),
    );

    await expect(unavailable.consume("key", 1, 60)).rejects.toBeInstanceOf(
      RateLimitUnavailableError,
    );
    await expect(malformed.consume("key", 1, 60)).rejects.toBeInstanceOf(
      RateLimitUnavailableError,
    );
  });
});
