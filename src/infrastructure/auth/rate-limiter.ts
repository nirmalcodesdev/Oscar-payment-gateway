import type { Redis } from "ioredis";

const consumeScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

export class RateLimitUnavailableError extends Error {
  public constructor() {
    super("Rate limiting dependency is unavailable");
    this.name = "RateLimitUnavailableError";
  }
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly count: number;
  readonly retryAfterSec: number;
}

export class RedisRateLimiter {
  readonly #redis: Redis;

  public constructor(redis: Redis) {
    this.#redis = redis;
  }

  public async consume(
    key: string,
    limit: number,
    windowSec: number,
  ): Promise<RateLimitDecision> {
    let result: unknown;
    try {
      result = await this.#redis.eval(consumeScript, 1, key, windowSec);
    } catch {
      throw new RateLimitUnavailableError();
    }
    if (!Array.isArray(result) || result.length !== 2) {
      throw new RateLimitUnavailableError();
    }
    const count = Number(result[0]);
    const ttl = Number(result[1]);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(ttl)) {
      throw new RateLimitUnavailableError();
    }
    return { allowed: count <= limit, count, retryAfterSec: Math.max(1, ttl) };
  }

  public async clear(key: string): Promise<void> {
    try {
      await this.#redis.del(key);
    } catch {
      throw new RateLimitUnavailableError();
    }
  }

  public async consumeStepUp(jti: string, ttlSec: number): Promise<boolean> {
    try {
      const result = await this.#redis.set(
        `oscar:step-up:${jti}`,
        "1",
        "EX",
        ttlSec,
        "NX",
      );
      return result === "OK";
    } catch {
      throw new RateLimitUnavailableError();
    }
  }
}
