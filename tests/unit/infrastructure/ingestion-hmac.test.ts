import type { Connection } from "mongoose";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/environment.js";
import {
  IngestionAuthError,
  IngestionHmacVerifier,
  ingestionHeaderNames,
  signIngestionPayload,
  type IngestionRequest,
} from "../../../src/infrastructure/auth/ingestion-hmac.js";
import { validEnvironment } from "../../helpers/environment.js";

const currentSecret = "test-ingestion-hmac-current-secret-0001";
const previousSecret = "test-ingestion-hmac-previous-secret-0002";
const fixedNow = new Date("2026-08-15T12:00:00.000Z");
const timestamp = (fixedNow.getTime() / 1000).toString(10);
const nonce = "nonce-0123456789abcdef";
const body = Buffer.from(JSON.stringify({ chain: "ethereum-sepolia" }), "utf8");

interface ConsumedNonce {
  readonly keyId: string;
  readonly nonce: string;
  readonly consumedAt: Date;
  readonly expiresAt: Date;
}

function duplicateKeyError(): Error & { readonly code: number } {
  const error = new Error("E11000 duplicate key") as Error & { code: number };
  error.code = 11_000;
  return error;
}

/**
 * Detached connection whose only live model is ConsumedHmacNonce, backed by an
 * in-memory set. These tests never touch the database: every matrix path stops
 * before, at, or inside the nonce-consumption step.
 */
function fakeConnection(consumed: Set<string>): {
  readonly connection: Connection;
  readonly creates: readonly ConsumedNonce[];
} {
  const creates: ConsumedNonce[] = [];
  const models: Record<string, unknown> = {};
  const connection = {
    models,
    model(name: string) {
      const existing = models[name];
      if (existing !== undefined) return existing;
      const model =
        name === "ConsumedHmacNonce"
          ? {
              create(document: ConsumedNonce) {
                const key = `${document.keyId}:${document.nonce}`;
                if (consumed.has(key)) return Promise.reject(duplicateKeyError());
                consumed.add(key);
                creates.push(document);
                return Promise.resolve(document);
              },
            }
          : {};
      models[name] = model;
      return model;
    },
  } as unknown as Connection;
  return { connection, creates };
}

function verifier(options: {
  withPreviousKey?: boolean;
  now?: () => Date;
  consumedNonces?: Set<string>;
}): {
  readonly service: IngestionHmacVerifier;
  readonly creates: readonly ConsumedNonce[];
} {
  const overrides = options.withPreviousKey
    ? {
        INGESTION_HMAC_PREVIOUS_KEY_ID: "test-ingest-v0",
        INGESTION_HMAC_PREVIOUS_SECRET: previousSecret,
      }
    : {};
  const config = loadConfig(validEnvironment(overrides)).ingestion;
  const { connection, creates } = fakeConnection(options.consumedNonces ?? new Set());
  return {
    service: new IngestionHmacVerifier(connection, {
      config,
      now: options.now ?? (() => fixedNow),
    }),
    creates,
  };
}

function signedRequest(
  overrides: Partial<Omit<IngestionRequest, "body">> = {},
): IngestionRequest {
  const signature = signIngestionPayload(currentSecret, timestamp, nonce, body);
  return {
    keyId: "test-ingest-v1",
    timestamp,
    nonce,
    signature,
    body,
    ...overrides,
  };
}

describe("signIngestionPayload", () => {
  it("is deterministic over the exact timestamp/nonce/body bytes", () => {
    const first = signIngestionPayload(currentSecret, timestamp, nonce, body);
    const second = signIngestionPayload(currentSecret, timestamp, nonce, body);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces distinct signatures for every signing input", () => {
    const baseline = signIngestionPayload(currentSecret, timestamp, nonce, body);
    const variants = [
      signIngestionPayload(previousSecret, timestamp, nonce, body),
      signIngestionPayload(currentSecret, `${timestamp}1`, nonce, body),
      signIngestionPayload(currentSecret, timestamp, "other-nonce-value-0000", body),
      signIngestionPayload(currentSecret, timestamp, nonce, Buffer.from("{}")),
    ];
    for (const variant of variants) {
      expect(variant).not.toBe(baseline);
    }
  });
});

describe("IngestionHmacVerifier matrix", () => {
  it("verifies a request signed with the current key", async () => {
    const { service, creates } = verifier({});
    await expect(service.verify(signedRequest())).resolves.toBeUndefined();
    expect(creates).toEqual([
      {
        keyId: "test-ingest-v1",
        nonce,
        consumedAt: fixedNow,
        expiresAt: new Date(fixedNow.getTime() + 600_000),
      },
    ]);
  });

  it("verifies a request signed with the previous key during rotation overlap", async () => {
    const { service, creates } = verifier({ withPreviousKey: true });
    const signature = signIngestionPayload(previousSecret, timestamp, nonce, body);
    await expect(
      service.verify(signedRequest({ keyId: "test-ingest-v0", signature })),
    ).resolves.toBeUndefined();
    expect(creates).toEqual([
      expect.objectContaining({ keyId: "test-ingest-v0", nonce }),
    ]);
  });

  it("rejects an unknown key id before checking the signature", async () => {
    const { service } = verifier({ withPreviousKey: true });
    await expect(
      service.verify(signedRequest({ keyId: "test-ingest-v9" })),
    ).rejects.toMatchObject(new IngestionAuthError("unknown_key"));
  });

  it("rejects a valid previous-key signature when no rotation key is configured", async () => {
    const { service } = verifier({});
    const signature = signIngestionPayload(previousSecret, timestamp, nonce, body);
    await expect(
      service.verify(signedRequest({ keyId: "test-ingest-v0", signature })),
    ).rejects.toMatchObject(new IngestionAuthError("unknown_key"));
  });

  it("accepts a stale timestamp exactly at the skew boundary", async () => {
    const { service } = verifier({
      now: () => new Date(fixedNow.getTime() + 300_000),
    });
    await expect(service.verify(signedRequest())).resolves.toBeUndefined();
  });

  it("rejects a stale timestamp one second past the skew window", async () => {
    const { service } = verifier({
      now: () => new Date(fixedNow.getTime() + 301_000),
    });
    await expect(service.verify(signedRequest())).rejects.toMatchObject(
      new IngestionAuthError("timestamp_skew"),
    );
  });

  it("rejects a future timestamp beyond the skew window", async () => {
    const { service } = verifier({
      now: () => new Date(fixedNow.getTime() - 301_000),
    });
    await expect(service.verify(signedRequest())).rejects.toMatchObject(
      new IngestionAuthError("timestamp_skew"),
    );
  });

  it("rejects a tampered body after the signature was computed", async () => {
    const { service } = verifier({});
    const tampered = Buffer.from(JSON.stringify({ chain: "bitcoin-mainnet" }), "utf8");
    const request = signedRequest();
    await expect(service.verify({ ...request, body: tampered })).rejects.toMatchObject(
      new IngestionAuthError("invalid_signature"),
    );
  });

  it("rejects a signature recomputed with a different secret", async () => {
    const { service } = verifier({});
    const forged = signIngestionPayload(
      "another-secret-entirely",
      timestamp,
      nonce,
      body,
    );
    await expect(
      service.verify(signedRequest({ signature: forged })),
    ).rejects.toMatchObject(new IngestionAuthError("invalid_signature"));
  });

  it("rejects a replayed request whose nonce was already consumed", async () => {
    const consumed = new Set<string>([`test-ingest-v1:${nonce}`]);
    const { service, creates } = verifier({ consumedNonces: consumed });
    await expect(service.verify(signedRequest())).rejects.toMatchObject(
      new IngestionAuthError("nonce_reused"),
    );
    expect(creates).toEqual([]);
  });

  it("consumes the nonce only after all earlier checks pass", async () => {
    const { service, creates } = verifier({});
    await expect(
      service.verify(signedRequest({ timestamp: "nope" })),
    ).rejects.toMatchObject(new IngestionAuthError("malformed_headers"));
    expect(creates).toEqual([]);
  });

  it.each([
    "non-hex-signature-value-0000",
    "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef01234567",
    "abcdef",
  ])("rejects a malformed signature header %j", async (signature) => {
    const { service } = verifier({});
    await expect(service.verify(signedRequest({ signature }))).rejects.toMatchObject(
      new IngestionAuthError("malformed_headers"),
    );
  });

  it.each(["not-a-timestamp", `${timestamp}x`, "-5"])(
    "rejects a malformed timestamp header %j",
    async (header) => {
      const { service } = verifier({});
      const signature = signIngestionPayload(currentSecret, header, nonce, body);
      await expect(
        service.verify(signedRequest({ timestamp: header, signature })),
      ).rejects.toMatchObject(new IngestionAuthError("malformed_headers"));
    },
  );

  it.each(["short", "n".repeat(256), "nonce with spaces in it"])(
    "rejects a malformed nonce header %j",
    async (header) => {
      const { service } = verifier({});
      const signature = signIngestionPayload(currentSecret, timestamp, header, body);
      await expect(
        service.verify(signedRequest({ nonce: header, signature })),
      ).rejects.toMatchObject(new IngestionAuthError("malformed_headers"));
    },
  );

  it("rejects malformed headers before resolving the key id", async () => {
    const { service } = verifier({});
    await expect(
      service.verify(signedRequest({ keyId: "test-ingest-v9", timestamp: "nope" })),
    ).rejects.toMatchObject(new IngestionAuthError("malformed_headers"));
  });

  it("derives every header name used by the router and client", () => {
    expect(ingestionHeaderNames).toEqual({
      keyId: "x-oscar-event-key-id",
      timestamp: "x-oscar-event-timestamp",
      nonce: "x-oscar-event-nonce",
      signature: "x-oscar-event-signature",
    });
  });
});
