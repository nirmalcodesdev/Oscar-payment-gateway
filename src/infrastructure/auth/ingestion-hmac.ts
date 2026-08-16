import { createHmac, timingSafeEqual } from "node:crypto";

import type { Connection } from "mongoose";

import type { RuntimeConfig } from "../../config/environment.js";
import { registerPersistenceModels } from "../mongodb/models.js";

export const ingestionHeaderNames = {
  keyId: "x-oscar-event-key-id",
  timestamp: "x-oscar-event-timestamp",
  nonce: "x-oscar-event-nonce",
  signature: "x-oscar-event-signature",
} as const;

const noncePattern = /^[A-Za-z0-9._-]{16,255}$/;
const timestampPattern = /^[0-9]{1,15}$/;
const signaturePattern = /^[0-9a-f]{64}$/;

export type IngestionAuthFailureReason =
  | "malformed_headers"
  | "unknown_key"
  | "timestamp_skew"
  | "invalid_signature"
  | "nonce_reused";

export class IngestionAuthError extends Error {
  public readonly reason: IngestionAuthFailureReason;

  public constructor(reason: IngestionAuthFailureReason) {
    super("Internal event authentication failed");
    this.name = "IngestionAuthError";
    this.reason = reason;
  }
}

export interface IngestionRequest {
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
  readonly body: Buffer;
}

/**
 * Compute the lowercase hex HMAC-SHA256 signature over the exact bytes
 * `${timestamp}\n${nonce}\n${body}`.
 */
export function signIngestionPayload(
  secret: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}\n${nonce}\n`, "utf8");
  mac.update(body);
  return mac.digest("hex");
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === 11_000
  );
}

export interface IngestionHmacVerifierDependencies {
  readonly config: RuntimeConfig["ingestion"];
  readonly now?: () => Date;
}

/**
 * Verifies internal ingestion requests with versioned HMAC keys. Replay
 * protection consumes each `(keyId, nonce)` pair atomically after signature
 * verification; the unique index makes replay rejection a database guarantee
 * and the TTL index expires consumed nonces.
 */
export class IngestionHmacVerifier {
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #config: RuntimeConfig["ingestion"];
  readonly #now: () => Date;

  public constructor(
    connection: Connection,
    dependencies: IngestionHmacVerifierDependencies,
  ) {
    this.#models = registerPersistenceModels(connection);
    this.#config = dependencies.config;
    this.#now = dependencies.now ?? (() => new Date());
  }

  #secretFor(keyId: string): string | undefined {
    if (keyId === this.#config.hmacCurrentKeyId) {
      return this.#config.hmacCurrentSecret;
    }
    if (
      this.#config.hmacPreviousKeyId !== undefined &&
      keyId === this.#config.hmacPreviousKeyId
    ) {
      return this.#config.hmacPreviousSecret;
    }
    return undefined;
  }

  public async verify(request: IngestionRequest): Promise<void> {
    if (
      !timestampPattern.test(request.timestamp) ||
      !noncePattern.test(request.nonce) ||
      !signaturePattern.test(request.signature)
    ) {
      throw new IngestionAuthError("malformed_headers");
    }

    const secret = this.#secretFor(request.keyId);
    if (secret === undefined) {
      throw new IngestionAuthError("unknown_key");
    }

    const timestampSec = Number(request.timestamp);
    const nowSec = Math.floor(this.#now().getTime() / 1000);
    if (Math.abs(nowSec - timestampSec) > this.#config.timestampSkewSec) {
      throw new IngestionAuthError("timestamp_skew");
    }

    const expected = Buffer.from(
      signIngestionPayload(secret, request.timestamp, request.nonce, request.body),
      "hex",
    );
    const supplied = Buffer.from(request.signature, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new IngestionAuthError("invalid_signature");
    }

    const consumedAt = this.#now();
    const expiresAt = new Date(consumedAt.getTime() + this.#config.nonceTtlSec * 1000);
    try {
      await this.#models.ConsumedHmacNonce.create({
        keyId: request.keyId,
        nonce: request.nonce,
        consumedAt,
        expiresAt,
      });
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        throw new IngestionAuthError("nonce_reused");
      }
      throw error;
    }
  }
}
