import { randomBytes } from "node:crypto";

import type { Redis } from "ioredis";

const releaseScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export interface PaymentLockHandle {
  readonly paymentId: string;
  release(): Promise<void>;
}

/**
 * Payment-scoped coordination lock (ADR 0011). Serializes match+transition
 * work per payment to reduce contention, but is never a correctness guard:
 * the conditional database writes re-verify status, version, and claim
 * ownership, so lock expiry mid-work only costs a redundant no-op attempt.
 * Release is a token compare-and-delete so an expired lock is never freed
 * by its previous owner.
 */
export class PaymentLock {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlMs: number;

  public constructor(redis: Redis, queuePrefix: string, ttlMs = 30_000) {
    this.#redis = redis;
    this.#prefix = `${queuePrefix}:payment-lock`;
    this.#ttlMs = ttlMs;
  }

  public async acquire(paymentId: string): Promise<PaymentLockHandle | undefined> {
    const token = randomBytes(16).toString("hex");
    const key = `${this.#prefix}:${paymentId}`;
    const acquired = await this.#redis.set(key, token, "PX", this.#ttlMs, "NX");
    if (acquired !== "OK") return undefined;
    return {
      paymentId,
      release: async () => {
        await this.#redis.eval(releaseScript, 1, key, token);
      },
    };
  }

  /**
   * Run an operation while holding the payment lock when it can be acquired.
   * A contended lock does not wait: the caller proceeds unlocked because the
   * database remains the correctness boundary.
   */
  public async withLock<T>(paymentId: string, operation: () => Promise<T>): Promise<T> {
    const handle = await this.acquire(paymentId);
    if (handle === undefined) return operation();
    try {
      return await operation();
    } finally {
      await handle.release();
    }
  }
}
