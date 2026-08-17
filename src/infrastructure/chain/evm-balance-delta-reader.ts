import { getAddress, type Address } from "viem";
import type { Logger } from "pino";

import type {
  BalanceDeltaRead,
  BalanceDeltaReader,
} from "../../domain/chain/chain-adapter.js";
import type { ResolvedProviderClient } from "../chain/evm-chain-adapter.js";

function allEqual(values: readonly unknown[]): boolean {
  return values.length > 0 && values.every((value) => value === values[0]);
}

/**
 * Corroborated recipient balance-delta reader (ADR 0010). Reads the holder's
 * ERC-20 balance at the block before the transfer and at the transfer block
 * through at least two independent providers; a delta is reported only when
 * every provider computes the same value, otherwise the read yields a review
 * outcome upstream.
 */
export class EvmBalanceDeltaReader implements BalanceDeltaReader {
  #providersByChain: ReadonlyMap<string, readonly ResolvedProviderClient[]>;
  readonly #logger: Logger;

  public constructor(
    providersByChain: ReadonlyMap<string, readonly ResolvedProviderClient[]>,
    logger: Logger,
  ) {
    this.#providersByChain = providersByChain;
    this.#logger = logger.child({ component: "balance-delta-reader" });
  }

  /** Replace the provider map after a registry refresh (atomic swap). */
  public setProvidersByChain(
    providersByChain: ReadonlyMap<string, readonly ResolvedProviderClient[]>,
  ): void {
    this.#providersByChain = providersByChain;
  }

  public async readDelta(input: {
    readonly chain: string;
    readonly contractAddress?: string;
    readonly holder: string;
    readonly blockNumber: number;
  }): Promise<BalanceDeltaRead> {
    const providers = this.#providersByChain.get(input.chain);
    if (providers === undefined || providers.length < 2) {
      return { status: "unavailable" };
    }

    let holder: Address;
    try {
      holder = getAddress(input.holder);
    } catch {
      return { status: "unavailable" };
    }
    const transferBlock = BigInt(input.blockNumber);
    const beforeBlock = transferBlock - 1n;
    if (beforeBlock < 0n) {
      return { status: "unavailable" };
    }

    let contract: Address | undefined;
    if (input.contractAddress !== undefined) {
      try {
        contract = getAddress(input.contractAddress);
      } catch {
        return { status: "unavailable" };
      }
    }

    const deltas: bigint[] = [];
    for (const provider of providers) {
      try {
        const before =
          contract === undefined
            ? await provider.client.readNativeBalance(holder, beforeBlock)
            : await provider.client.readErc20Balance(contract, holder, beforeBlock);
        const after =
          contract === undefined
            ? await provider.client.readNativeBalance(holder, transferBlock)
            : await provider.client.readErc20Balance(contract, holder, transferBlock);
        deltas.push(after - before);
      } catch (error: unknown) {
        this.#logger.warn(
          {
            err: error,
            chain: input.chain,
            providerId: provider.reference.providerId,
            holder: input.holder,
            blockNumber: input.blockNumber,
          },
          "Balance delta provider read failed",
        );
        return { status: "unavailable" };
      }
    }

    if (!allEqual(deltas)) {
      this.#logger.warn(
        {
          chain: input.chain,
          holder: input.holder,
          blockNumber: input.blockNumber,
          deltas: deltas.map((delta) => delta.toString()),
        },
        "Providers disagree on recipient balance delta",
      );
      return { status: "disagreement" };
    }
    // Unreachable: every provider pushed a delta or returned early, and the
    // provider-count guard above ensures at least two entries.
    const delta = deltas[0];
    if (delta === undefined) return { status: "unavailable" };
    return { status: "agreeing", delta: delta.toString() };
  }
}
