import { getAddress, type Address } from "viem";
import type { Logger } from "pino";

import { containsNonStandardContractError } from "./evm-registry-verifier.js";
import type { ResolvedProviderClient } from "./evm-chain-adapter.js";

export type DecimalGuardFailureReason =
  | "provider_disagreement"
  | "provider_unavailable"
  | "decimal_mismatch"
  | "metadata_missing"
  | "unverifiable_response";

export type DecimalGuardOutcome =
  | { readonly verified: true; readonly decimals: number }
  | { readonly verified: false; readonly reason: DecimalGuardFailureReason };

/**
 * Live decimal verification for watched token contracts (ADR 0009). Reads
 * `decimals()` through at least two independent providers at a shared block
 * and reports why a token cannot be watched; the watcher excludes the token
 * and records an audit entry without mutating the registry (ADR 0007 owns
 * resolution).
 */
export class EvmDecimalGuard {
  readonly #providers: readonly ResolvedProviderClient[];
  readonly #logger: Logger;

  public constructor(providers: readonly ResolvedProviderClient[], logger: Logger) {
    if (providers.length < 2) {
      throw new Error("Decimal guard requires at least two providers");
    }
    this.#providers = providers;
    this.#logger = logger.child({ component: "decimal-guard" });
  }

  public async verifyDecimals(
    contractAddress: string,
    expectedDecimals: number,
  ): Promise<DecimalGuardOutcome> {
    let normalized: Address;
    try {
      normalized = getAddress(contractAddress);
    } catch {
      return { verified: false, reason: "unverifiable_response" };
    }

    let blockNumbers: bigint[];
    try {
      blockNumbers = await Promise.all(
        this.#providers.map((provider) => provider.client.getBlockNumber()),
      );
    } catch {
      return { verified: false, reason: "provider_unavailable" };
    }
    const sharedBlock = blockNumbers.reduce((lowest, current) =>
      current < lowest ? current : lowest,
    );

    let bytecodes: (`0x${string}` | undefined)[];
    try {
      bytecodes = await Promise.all(
        this.#providers.map((provider) =>
          provider.client.getBytecode(normalized, sharedBlock),
        ),
      );
    } catch {
      return { verified: false, reason: "provider_unavailable" };
    }
    if (bytecodes.some((bytecode) => bytecode === undefined || bytecode === "0x")) {
      return { verified: false, reason: "metadata_missing" };
    }

    const decimalsReads = await Promise.all(
      this.#providers.map(async (provider) => {
        try {
          return {
            value: await provider.client.readErc20Decimals(normalized, sharedBlock),
          };
        } catch (error: unknown) {
          if (containsNonStandardContractError(error)) {
            return { nonStandard: true as const };
          }
          return { unavailable: true as const };
        }
      }),
    );
    if (decimalsReads.some((read) => "unavailable" in read)) {
      return { verified: false, reason: "provider_unavailable" };
    }
    if (decimalsReads.some((read) => "nonStandard" in read)) {
      return { verified: false, reason: "unverifiable_response" };
    }

    const decimals = decimalsReads.map(
      (read) => (read as { readonly value: number }).value,
    );
    if (!decimals.every((value) => value === decimals[0])) {
      this.#logger.warn(
        { contractAddress: normalized, decimals, sharedBlock: sharedBlock.toString() },
        "Providers disagree on live token decimals",
      );
      return { verified: false, reason: "provider_disagreement" };
    }
    if (decimals[0] !== expectedDecimals) {
      this.#logger.warn(
        {
          contractAddress: normalized,
          liveDecimals: decimals[0],
          expectedDecimals,
          sharedBlock: sharedBlock.toString(),
        },
        "Live token decimals differ from registry metadata",
      );
      return { verified: false, reason: "decimal_mismatch" };
    }
    return { verified: true, decimals: decimals[0] };
  }
}
