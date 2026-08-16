import type { Logger } from "pino";

import type {
  ConfirmationObservation,
  PaymentConfirmationReader,
} from "../../application/processing/payment-confirmation-service.js";
import type { ResolvedProviderClient } from "./evm-chain-adapter.js";

/**
 * Corroborated confirmation reader (ADR 0012). Reads the chain tip and the
 * event's block header through the chain's independent providers; a result
 * is reported only when every provider agrees on the header hash, and the
 * depth is derived from the lowest observed tip so a lagging provider can
 * never inflate confirmations. Any failure or disagreement is `unavailable`
 * so the caller fails closed.
 */
export class EvmConfirmationReader implements PaymentConfirmationReader {
  #providersByChain: ReadonlyMap<string, readonly ResolvedProviderClient[]>;
  readonly #logger: Logger;

  public constructor(
    providersByChain: ReadonlyMap<string, readonly ResolvedProviderClient[]>,
    logger: Logger,
  ) {
    this.#providersByChain = providersByChain;
    this.#logger = logger.child({ component: "confirmation-reader" });
  }

  /** Replace the provider map after a registry refresh (atomic swap). */
  public setProvidersByChain(
    providersByChain: ReadonlyMap<string, readonly ResolvedProviderClient[]>,
  ): void {
    this.#providersByChain = providersByChain;
  }

  public async observe(event: {
    readonly chain: string;
    readonly transactionHash: string;
    readonly blockNumber: number;
    readonly blockHash: string;
  }): Promise<ConfirmationObservation> {
    const providers = this.#providersByChain.get(event.chain);
    if (providers === undefined || providers.length < 2) {
      return { status: "unavailable" };
    }

    const eventBlock = BigInt(event.blockNumber);
    let lowestTip: bigint | undefined;
    for (const provider of providers) {
      try {
        const header = await provider.client.getBlockHeader(eventBlock);
        if (header.blockHash.toLowerCase() !== event.blockHash.toLowerCase()) {
          // The recorded event block is no longer what the chain reports at
          // that height: the transaction's block was reorged out.
          return { status: "observed", canonical: false, confirmations: 0 };
        }
        const tip = await provider.client.getBlockNumber();
        lowestTip = lowestTip === undefined ? tip : lowestTip < tip ? lowestTip : tip;
      } catch (error: unknown) {
        this.#logger.warn(
          {
            err: error,
            chain: event.chain,
            providerId: provider.reference.providerId,
            blockNumber: event.blockNumber,
          },
          "Confirmation provider read failed",
        );
        return { status: "unavailable" };
      }
    }

    if (lowestTip === undefined || lowestTip < eventBlock) {
      return { status: "unavailable" };
    }
    const confirmations = Number(lowestTip - eventBlock) + 1;
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
      return { status: "unavailable" };
    }
    return {
      status: "observed",
      canonical: true,
      confirmations,
    };
  }
}
