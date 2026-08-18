import type { Connection } from "mongoose";
import type { Logger } from "pino";
import type { Redis } from "ioredis";

import type { RuntimeConfig } from "../../config/environment.js";
import {
  ReorgResolutionService,
  type ReorgResolutionOutcome,
} from "../../application/watcher/reorg-resolution-service.js";
import {
  WatcherService,
  type RegistryChainRecord,
  type WatcherChainRuntime,
  type WatcherLogDecoder,
} from "../../application/watcher/watcher-service.js";
import {
  createChainAdapter,
  type CreatedChainAdapter,
} from "../chain/chain-adapter-factory.js";
import { EvmDecimalGuard } from "../chain/decimal-guard.js";
import { MongoChainCursorStorage } from "../chain/mongo-cursor-storage.js";
import type { EvmProviderClientFactory } from "../chain/evm-registry-verifier.js";
import { SignedIngestionClient } from "../http/ingestion-client.js";
import { walletWatchlistRefreshChannel } from "../redis/watchlist-refresh-signal.js";
import type { ManagedResource } from "./managed-resource.js";

export interface WatcherResourceOptions {
  readonly connection: Connection;
  readonly config: RuntimeConfig;
  readonly logger: Logger;
  readonly redis?: Redis;
  readonly providerFactory?: EvmProviderClientFactory;
  readonly logDecoder?: WatcherLogDecoder;
}

/**
 * Watcher-process resource (ADR 0009). Owns the watcher pipeline: adapters are
 * created per enabled registry chain, verified through all providers, and run
 * together with the registry refresh timer. Readiness degrades when no chain is
 * watchable while enabled chains exist.
 */
export class WatcherResource implements ManagedResource {
  public readonly name = "watcher";
  readonly #service: WatcherService;
  readonly #adapters = new Map<string, CreatedChainAdapter>();

  public constructor(options: WatcherResourceOptions) {
    const logger = options.logger.child({ component: "watcher-resource" });
    const providerFactory = options.providerFactory;
    const adapters = this.#adapters;
    const rpcConfig = options.config.rpc;
    const watcherConfig = options.config.watcher;
    const reorgResolver = new ReorgResolutionService(
      options.connection,
      options.config.processing,
      options.logger,
    );
    this.#service = new WatcherService({
      connection: options.connection,
      config: options.config.watcher,
      ingestionClient: new SignedIngestionClient({ config: options.config.ingestion }),
      logger: options.logger,
      reorgResolver: {
        resolve: (runtime): Promise<ReorgResolutionOutcome> =>
          reorgResolver.resolve(runtime),
      },
      ...(options.logDecoder === undefined ? {} : { logDecoder: options.logDecoder }),
      runtimeFactory: {
        async create(chain: RegistryChainRecord): Promise<WatcherChainRuntime> {
          const adapter = createChainAdapter({
            chain: {
              chainId: chain.chainId,
              networkFamily: chain.networkFamily,
              networkChainId: chain.networkChainId,
              rpcProviders: chain.rpcProviders,
            },
            config: rpcConfig,
            logger,
            ...(providerFactory === undefined ? {} : { providerFactory }),
            pollIntervalMs: watcherConfig.pollIntervalMs,
            watchBatchSize: watcherConfig.batchSize,
          });
          await adapter.init();
          adapters.set(chain.chainId, adapter);
          const providers = adapter.providers();
          return {
            chainId: chain.chainId,
            adapter,
            observation: adapter,
            corroborator: adapter,
            cursorStorage: new MongoChainCursorStorage(
              options.connection,
              chain.chainId,
            ),
            decimalVerifier:
              providers.length < 2
                ? {
                    verifyDecimals: () =>
                      Promise.resolve({
                        verified: false,
                        reason: "provider_unavailable",
                      } as const),
                  }
                : new EvmDecimalGuard(providers, logger),
          };
        },
      },
    });

    if (options.redis !== undefined) {
      const channel = walletWatchlistRefreshChannel(options.config.redis.queuePrefix);
      options.redis.on("message", (rx, message) => {
        if (rx === channel && message === "refresh") {
          void this.#service.refreshRegistry();
        }
      });
      options.redis.subscribe(channel).catch(() => {
        // Best effort; the polling timer remains the fallback.
      });
    }
  }

  public async start(): Promise<void> {
    await this.#service.start();
  }

  public async stop(): Promise<void> {
    await this.#service.stop();
    this.#adapters.clear();
  }

  public isReady(): Promise<boolean> {
    return Promise.resolve(this.#service.isReady());
  }
}
