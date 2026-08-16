import { randomBytes } from "node:crypto";

import type { RuntimeConfig } from "../../config/environment.js";
import type { OnChainDepositEvent } from "../../domain/chain/chain-adapter.js";
import { ingestionHeaderNames, signIngestionPayload } from "../auth/ingestion-hmac.js";
import {
  generateTraceContext,
  traceParentHeader,
} from "../observability/trace-context.js";

export interface IngestionSubmitResult {
  readonly eventId: string;
  readonly replayed: boolean;
}

export interface IngestionClient {
  submitEvent(event: OnChainDepositEvent): Promise<IngestionSubmitResult>;
}

export class IngestionClientError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "IngestionClientError";
    this.statusCode = statusCode;
  }
}

interface IngestionBody {
  readonly chain: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly contractAddress: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amount: string;
  readonly rawEvent: Readonly<Record<string, unknown>>;
  readonly confirmationsAtIngest?: number;
}

export interface SignedIngestionClientOptions {
  readonly config: RuntimeConfig["ingestion"];
  readonly timeoutMs?: number;
}

/**
 * Producer for the internal ingestion endpoint (ADR 0010). Signs the exact
 * request bytes with the current HMAC key; retries are safe because the
 * endpoint collapses every producer and retry onto one event identity.
 */
export class SignedIngestionClient implements IngestionClient {
  readonly #config: RuntimeConfig["ingestion"];
  readonly #timeoutMs: number;

  public constructor(options: SignedIngestionClientOptions) {
    this.#config = options.config;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  public async submitEvent(event: OnChainDepositEvent): Promise<IngestionSubmitResult> {
    const body: IngestionBody = {
      chain: event.chain,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      contractAddress: event.contractAddress,
      fromAddress: event.fromAddress,
      toAddress: event.toAddress,
      amount: event.amount,
      rawEvent: event.rawEvent,
    };
    const rawBody = Buffer.from(JSON.stringify(body), "utf8");
    const timestamp = Math.floor(Date.now() / 1000).toString(10);
    const nonce = randomBytes(32).toString("base64url");
    const signature = signIngestionPayload(
      this.#config.hmacCurrentSecret,
      timestamp,
      nonce,
      rawBody,
    );

    let response: Response;
    try {
      response = await fetch(
        `${this.#config.internalBaseUrl}/api/v1/internal/on-chain-events`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [ingestionHeaderNames.keyId]: this.#config.hmacCurrentKeyId,
            [ingestionHeaderNames.timestamp]: timestamp,
            [ingestionHeaderNames.nonce]: nonce,
            [ingestionHeaderNames.signature]: signature,
            // W3C trace propagation on internal egress (ADR 0016).
            traceparent: traceParentHeader(generateTraceContext()),
          },
          body: rawBody,
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch (error: unknown) {
      throw new IngestionClientError(
        0,
        `Ingestion endpoint unreachable: ${(error as Error).message}`,
      );
    }

    const text = await response.text();
    if (response.status !== 200 && response.status !== 201) {
      throw new IngestionClientError(
        response.status,
        `Ingestion endpoint rejected event (status ${response.status}): ${text.slice(0, 500)}`,
      );
    }
    let parsed: { eventId?: unknown; replayed?: unknown };
    try {
      parsed = JSON.parse(text) as { eventId?: unknown; replayed?: unknown };
    } catch {
      throw new IngestionClientError(
        response.status,
        "Ingestion endpoint returned an unparsable success body",
      );
    }
    if (typeof parsed.eventId !== "string" || typeof parsed.replayed !== "boolean") {
      throw new IngestionClientError(
        response.status,
        "Ingestion endpoint returned an unexpected success envelope",
      );
    }
    return { eventId: parsed.eventId, replayed: parsed.replayed };
  }
}
