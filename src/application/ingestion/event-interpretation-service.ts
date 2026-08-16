import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { BalanceDeltaReader } from "../../domain/chain/chain-adapter.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { EnabledRegistryReader } from "../registry/registry-reader.js";

export type InterpretationStatus = "accepted" | "rejected" | "review";

export type InterpretationReason =
  | "disabled_or_unknown_chain"
  | "unknown_or_disabled_token"
  | "malformed_log"
  | "unknown_recipient"
  | "balance_delta_disagreement"
  | "balance_delta_unavailable"
  | "balance_delta_negative";

export interface InterpretationOutcome {
  readonly eventId: string;
  readonly status: InterpretationStatus;
  readonly reason?: InterpretationReason;
  readonly verifiedReceivedAmount?: string;
  /** False when the outcome was already written by another worker. */
  readonly applied: boolean;
}

interface DecodedTransfer {
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amount: string;
}

const addressTopicPattern = /^0x000000(00){9}[0-9a-fA-F]{40}$/;
const wordPattern = /^0x[0-9a-fA-F]{64}$/;

/**
 * Re-derive the normalized transfer fields from the verbatim provider log.
 * The raw capture is the source of truth; a log whose shape or values do not
 * match the normalized fields recorded at ingest is malformed.
 */
export function decodeTransferFromRaw(
  rawEvent: Readonly<Record<string, unknown>>,
): DecodedTransfer | undefined {
  const topics = rawEvent["topics"];
  const data = rawEvent["data"];
  if (!Array.isArray(topics) || typeof data !== "string") return undefined;
  if (topics.length !== 3) return undefined;
  const [topic0, topic1, topic2] = topics as unknown[];
  if (
    typeof topic0 !== "string" ||
    typeof topic1 !== "string" ||
    typeof topic2 !== "string"
  ) {
    return undefined;
  }
  if (
    topic0.toLowerCase() !==
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" ||
    !addressTopicPattern.test(topic1) ||
    !addressTopicPattern.test(topic2) ||
    !wordPattern.test(data) ||
    data.length !== 66
  ) {
    return undefined;
  }
  // Zero-value transfers decode fine; rejection is a downstream judgment matter.
  const amount = BigInt(data).toString(10);
  return {
    fromAddress: `0x${topic1.slice(26)}`,
    toAddress: `0x${topic2.slice(26)}`,
    amount,
  };
}

/**
 * Interprets durably persisted raw on-chain events against the current
 * registry (ADR 0010). Raw capture fields are immutable; only the mutable
 * interpretation state is written, and only while it is still absent, so
 * duplicate queue delivery produces exactly one effective outcome.
 */
export class EventInterpretationService {
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #registryReader: EnabledRegistryReader;
  readonly #balanceDeltas: BalanceDeltaReader;

  public constructor(
    connection: Connection,
    balanceDeltas: BalanceDeltaReader,
    registryReader?: EnabledRegistryReader,
  ) {
    this.#models = registerPersistenceModels(connection);
    this.#registryReader = registryReader ?? new EnabledRegistryReader(connection);
    this.#balanceDeltas = balanceDeltas;
  }

  public async interpret(
    eventId: string,
    logger: Logger,
  ): Promise<InterpretationOutcome> {
    const event = await this.#models.OnChainEvent.findOne({ eventId }).lean();
    if (event === null) {
      throw new Error(`On-chain event ${eventId} was not found`);
    }
    if (event.interpretationStatus !== undefined) {
      return this.#existingOutcome(eventId, event);
    }

    const registry = await this.#registryReader.refresh();
    const revision = registry.revision;

    if (!registry.chains.some(({ chainId }) => chainId === event.chain)) {
      return this.#finalize(eventId, "rejected", "disabled_or_unknown_chain", {
        revision,
      });
    }

    const decoded = decodeTransferFromRaw(
      // Validated as `z.record(z.string(), z.unknown())` at ingest; the Mixed
      // schema type only round-trips as `any` in Mongoose.
      event.rawEvent as Readonly<Record<string, unknown>>,
    );
    const normalizedFieldsMatch =
      decoded !== undefined &&
      `0x${event.normalizedFromAddress.slice(2).toLowerCase()}` ===
        decoded.fromAddress.toLowerCase() &&
      `0x${event.normalizedToAddress.slice(2).toLowerCase()}` ===
        decoded.toAddress.toLowerCase() &&
      event.amount === decoded.amount;
    if (decoded === undefined || !normalizedFieldsMatch) {
      return this.#finalize(eventId, "rejected", "malformed_log", { revision });
    }

    const token = registry.tokens.find(
      ({ chain, normalizedContractAddress }) =>
        chain === event.chain &&
        normalizedContractAddress === event.normalizedContractAddress,
    );
    if (token === undefined) {
      return this.#finalize(eventId, "rejected", "unknown_or_disabled_token", {
        revision,
      });
    }

    const recipientKnown = await this.#isKnownRecipient(
      event.chain,
      event.normalizedToAddress,
    );
    if (!recipientKnown) {
      return this.#finalize(eventId, "rejected", "unknown_recipient", {
        revision,
        tokenId: token.tokenId,
      });
    }

    if (token.verificationPolicy === "balance_delta_required") {
      const read = await this.#balanceDeltas.readDelta({
        chain: event.chain,
        contractAddress: event.normalizedContractAddress,
        holder: event.normalizedToAddress,
        blockNumber: event.blockNumber,
      });
      if (read.status === "disagreement") {
        return this.#finalize(eventId, "review", "balance_delta_disagreement", {
          revision,
          tokenId: token.tokenId,
        });
      }
      if (read.status === "unavailable" || read.delta === undefined) {
        return this.#finalize(eventId, "review", "balance_delta_unavailable", {
          revision,
          tokenId: token.tokenId,
        });
      }
      // The reader reports deltas exactly as computed, including signed
      // values; judgment of a non-positive delta belongs here, so parse with
      // plain BigInt rather than the non-negative base-unit guard.
      if (BigInt(read.delta) <= 0n) {
        return this.#finalize(eventId, "review", "balance_delta_negative", {
          revision,
          tokenId: token.tokenId,
        });
      }
      logger.debug(
        { eventId, delta: read.delta, tokenId: token.tokenId },
        "Balance delta verified for high-risk token",
      );
      return this.#finalize(eventId, "accepted", undefined, {
        revision,
        tokenId: token.tokenId,
        verifiedReceivedAmount: read.delta,
      });
    }

    return this.#finalize(eventId, "accepted", undefined, {
      revision,
      tokenId: token.tokenId,
    });
  }

  #existingOutcome(
    eventId: string,
    event: {
      interpretationStatus?: unknown;
      interpretationReason?: unknown;
      verifiedReceivedAmount?: unknown;
    },
  ): InterpretationOutcome {
    return {
      eventId,
      status: event.interpretationStatus as InterpretationStatus,
      ...(typeof event.interpretationReason !== "string"
        ? {}
        : { reason: event.interpretationReason as InterpretationReason }),
      ...(typeof event.verifiedReceivedAmount !== "string"
        ? {}
        : { verifiedReceivedAmount: event.verifiedReceivedAmount }),
      applied: false,
    };
  }

  async #isKnownRecipient(chain: string, normalizedToAddress: string) {
    const match = await this.#models.WalletAddress.findOne({
      chain,
      normalizedAddress: normalizedToAddress,
      status: { $in: ["available", "assigned"] },
    }).lean();
    return match !== null;
  }

  async #finalize(
    eventId: string,
    status: InterpretationStatus,
    reason: InterpretationReason | undefined,
    options: {
      readonly revision: string;
      readonly tokenId?: string;
      readonly verifiedReceivedAmount?: string;
    },
  ): Promise<InterpretationOutcome> {
    const setFields: Record<string, unknown> = {
      interpretationStatus: status,
      interpretedAt: new Date(),
      interpretationRevision: options.revision,
      ...(reason === undefined ? {} : { interpretationReason: reason }),
      ...(options.tokenId === undefined ? {} : { token: options.tokenId }),
      ...(options.verifiedReceivedAmount === undefined
        ? {}
        : { verifiedReceivedAmount: options.verifiedReceivedAmount }),
    };

    const updated = await this.#models.OnChainEvent.findOneAndUpdate(
      { eventId, interpretationStatus: { $exists: false } },
      { $set: setFields },
      { new: true },
    ).lean();

    if (updated === null) {
      // Another worker already interpreted this event; that outcome stands.
      const existing = await this.#models.OnChainEvent.findOne({ eventId }).lean();
      if (existing === null) {
        throw new Error(`On-chain event ${eventId} disappeared during interpretation`);
      }
      return this.#existingOutcome(eventId, existing);
    }

    return {
      eventId,
      status,
      ...(reason === undefined ? {} : { reason }),
      ...(options.verifiedReceivedAmount === undefined
        ? {}
        : { verifiedReceivedAmount: options.verifiedReceivedAmount }),
      applied: true,
    };
  }
}
