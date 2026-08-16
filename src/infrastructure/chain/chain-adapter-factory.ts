import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import type {
  BlockHeaderCorroborator,
  ChainAdapter,
  ChainObservationPort,
} from "../../domain/chain/chain-adapter.js";
import {
  EvmChainAdapter,
  type EvmChainRecord,
  type ResolvedProviderClient,
} from "./evm-chain-adapter.js";
import type { EvmProviderClientFactory } from "./evm-registry-verifier.js";

export interface ChainAdapterRecord extends EvmChainRecord {
  readonly networkFamily: string;
}

export class UnsupportedChainFamilyError extends Error {
  public readonly networkFamily: string;

  public constructor(networkFamily: string, chainId: string) {
    super(`Chain ${chainId} has unsupported network family "${networkFamily}"`);
    this.name = "UnsupportedChainFamilyError";
    this.networkFamily = networkFamily;
  }
}

export interface ChainAdapterFactoryOptions {
  readonly chain: ChainAdapterRecord;
  readonly config: RuntimeConfig["rpc"];
  readonly logger: Logger;
  readonly providerFactory?: EvmProviderClientFactory;
  readonly pollIntervalMs?: number;
  readonly watchBatchSize?: number;
}

export type CreatedChainAdapter = ChainAdapter &
  ChainObservationPort &
  BlockHeaderCorroborator & {
    /** The chain's resolved provider clients (shared by the decimal guard). */
    providers(): readonly ResolvedProviderClient[];
  };

/**
 * Select the adapter implementation by `Chain.networkFamily` (ADR 0009).
 * `evm` is the only supported family in v1; anything else fails closed.
 */
export function createChainAdapter(
  options: ChainAdapterFactoryOptions,
): CreatedChainAdapter {
  if (options.chain.networkFamily !== "evm") {
    throw new UnsupportedChainFamilyError(
      options.chain.networkFamily,
      options.chain.chainId,
    );
  }
  return new EvmChainAdapter({
    chain: options.chain,
    config: options.config,
    logger: options.logger,
    ...(options.providerFactory === undefined
      ? {}
      : { factory: options.providerFactory }),
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.watchBatchSize === undefined
      ? {}
      : { watchBatchSize: options.watchBatchSize }),
  });
}
