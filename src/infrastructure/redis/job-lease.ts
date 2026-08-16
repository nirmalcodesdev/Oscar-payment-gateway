import { randomBytes } from "node:crypto";

import type { Redis } from "ioredis";

/**
 * Redis job lease for scheduler leader coordination (ADR 0015). Only the
 * lease holder executes a job tick; the lease reduces duplicate work while
 * every job remains idempotent at the database layer, so an expired lease
 * or split brain can never double-apply effects. Leases expire naturally
 * by TTL — releasing explicitly would risk un- leasing after a takeover.
 */
export class JobLease {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlMs: number;

  public constructor(redis: Redis, queuePrefix: string, ttlSec: number) {
    this.#redis = redis;
    this.#prefix = `${queuePrefix}:job-lease`;
    this.#ttlMs = ttlSec * 1_000;
  }

  public async acquire(job: string): Promise<boolean> {
    const token = randomBytes(16).toString("hex");
    const acquired = await this.#redis.set(
      `${this.#prefix}:${job}`,
      token,
      "PX",
      this.#ttlMs,
      "NX",
    );
    return acquired === "OK";
  }
}
