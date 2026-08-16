import type { Logger } from "pino";

import { EventInterpretationService } from "../application/ingestion/event-interpretation-service.js";
import { loadConfig, type ProcessName } from "../config/environment.js";
import { EvmBalanceDeltaReader } from "../infrastructure/chain/evm-balance-delta-reader.js";
import {
  resolveChainProviderClients,
  type ResolvedProviderClient,
} from "../infrastructure/chain/evm-chain-adapter.js";
import { EnabledRegistryReader } from "../application/registry/registry-reader.js";
import { LifecycleManager } from "../infrastructure/lifecycle/lifecycle-manager.js";
import type { ManagedResource } from "../infrastructure/lifecycle/managed-resource.js";
import { ResourceReadinessProbe } from "../infrastructure/lifecycle/readiness-probe.js";
import { WatcherResource } from "../infrastructure/lifecycle/watcher-resource.js";
import { createLogger } from "../infrastructure/logging/logger.js";
import { MongoResource } from "../infrastructure/mongodb/mongo-resource.js";
import { EventQueueResource } from "../infrastructure/queue/event-queue.js";
import { EventInterpretationWorkerResource } from "../infrastructure/queue/event-worker.js";
import { RedisResource } from "../infrastructure/redis/redis-resource.js";
import { createApp } from "../interfaces/http/create-app.js";
import { createAdminRegistryRouter } from "../interfaces/http/admin-registry-router.js";
import { HttpServerResource } from "../interfaces/http/http-server-resource.js";
import { createInternalEventsRouter } from "../interfaces/http/internal-events-router.js";
import { createMerchantSecurityRouter } from "../interfaces/http/merchant-security-router.js";
import { createPaymentsRouter } from "../interfaces/http/payments-router.js";

interface Runtime {
  readonly logger: Logger;
  readonly lifecycle: LifecycleManager;
  readonly shutdownTimeoutMs: number;
}

function createRuntime(processName: ProcessName): Runtime {
  const config = loadConfig();
  const logger = createLogger(config, processName);
  const mongo = new MongoResource(config.mongodb);
  const redis = new RedisResource(config.redis);
  const dependencies: ManagedResource[] = [mongo, redis];

  if (processName === "scheduler") {
    return {
      logger,
      lifecycle: new LifecycleManager(dependencies, logger),
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    };
  }

  if (processName === "watcher") {
    const watcher = new WatcherResource({
      connection: mongo.connection,
      config,
      logger,
    });
    return {
      logger,
      lifecycle: new LifecycleManager([...dependencies, watcher], logger),
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    };
  }

  if (processName === "processor") {
    const registryReader = new EnabledRegistryReader(mongo.connection);
    const balanceDeltas = new EvmBalanceDeltaReader(new Map(), logger);
    const providerSync = new BalanceDeltaProviderSync({
      config,
      reader: balanceDeltas,
      registryReader,
      logger,
      refreshSec: config.watcher.registryRefreshSec,
    });
    const worker = new EventInterpretationWorkerResource({
      redis: redis.client,
      queuePrefix: config.redis.queuePrefix,
      service: new EventInterpretationService(
        mongo.connection,
        balanceDeltas,
        registryReader,
      ),
      logger,
    });
    return {
      logger,
      lifecycle: new LifecycleManager([...dependencies, providerSync, worker], logger),
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    };
  }

  const merchantSecurityRouter = createMerchantSecurityRouter({
    connection: mongo.connection,
    redis: redis.client,
    config,
  });
  const adminRegistryRouter = createAdminRegistryRouter({
    connection: mongo.connection,
    redis: redis.client,
    config,
  });
  const paymentsRouter = createPaymentsRouter({
    connection: mongo.connection,
    redis: redis.client,
    config,
    logger,
  });
  const eventQueue = new EventQueueResource(redis.client, config.redis.queuePrefix);
  const internalEventsRouter = createInternalEventsRouter({
    connection: mongo.connection,
    config,
    queue: eventQueue.queue,
  });
  const app = createApp(logger, new ResourceReadinessProbe(dependencies, logger), {
    apiRouters: [
      merchantSecurityRouter,
      adminRegistryRouter,
      paymentsRouter,
      internalEventsRouter,
    ],
  });
  const httpServer = new HttpServerResource(app, config.api);
  return {
    logger,
    lifecycle: new LifecycleManager([...dependencies, eventQueue, httpServer], logger),
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  };
}

/**
 * Keeps the processor's corroborated balance-delta providers in sync with the
 * enabled registry on a bounded interval (ADR 0010). Provider configuration
 * failures degrade individual chains to "unavailable" reads (review outcome)
 * rather than failing processor startup.
 */
class BalanceDeltaProviderSync implements ManagedResource {
  public readonly name = "balance-delta-provider-sync";
  readonly #config: ReturnType<typeof loadConfig>;
  readonly #reader: EvmBalanceDeltaReader;
  readonly #registryReader: EnabledRegistryReader;
  readonly #logger: Logger;
  readonly #refreshSec: number;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;

  public constructor(options: {
    readonly config: ReturnType<typeof loadConfig>;
    readonly reader: EvmBalanceDeltaReader;
    readonly registryReader: EnabledRegistryReader;
    readonly logger: Logger;
    readonly refreshSec: number;
  }) {
    this.#config = options.config;
    this.#reader = options.reader;
    this.#registryReader = options.registryReader;
    this.#logger = options.logger.child({ component: "balance-delta-provider-sync" });
    this.#refreshSec = options.refreshSec;
  }

  public async start(): Promise<void> {
    await this.#sync();
    this.#timer = setInterval(() => {
      this.#inFlight ??= this.#sync()
        .catch((error: unknown) => {
          this.#logger.warn({ err: error }, "Balance-delta provider sync failed");
        })
        .finally(() => {
          this.#inFlight = undefined;
        });
    }, this.#refreshSec * 1_000);
  }

  public async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#inFlight !== undefined) {
      await this.#inFlight;
    }
  }

  public isReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async #sync(): Promise<void> {
    const snapshot = await this.#registryReader.refresh();
    const providersByChain = new Map<string, readonly ResolvedProviderClient[]>();
    for (const chain of snapshot.chains) {
      // The schema pins "evm" today; keep the family gate for future families.
      const networkFamily: string = chain.networkFamily;
      if (networkFamily !== "evm") continue;
      try {
        providersByChain.set(
          chain.chainId,
          resolveChainProviderClients({
            chainId: chain.chainId,
            rpcProviders: chain.rpcProviders,
            config: this.#config.rpc,
          }),
        );
      } catch (error: unknown) {
        this.#logger.warn(
          { err: error, chainId: chain.chainId },
          "Balance-delta providers unresolved; chain reads will be unavailable",
        );
      }
    }
    this.#reader.setProvidersByChain(providersByChain);
  }
}

function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Shutdown exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    timeout.unref();
  });
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

export async function runProcess(processName: ProcessName): Promise<void> {
  let runtime: Runtime;
  try {
    runtime = createRuntime(processName);
  } catch {
    process.stderr.write(
      `${JSON.stringify({ level: "fatal", process: processName, message: "Configuration failed" })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { lifecycle, logger, shutdownTimeoutMs } = runtime;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ reason }, "Process shutdown started");
    try {
      await withTimeout(lifecycle.stop(), shutdownTimeoutMs);
      logger.info({ reason }, "Process shutdown completed");
      process.exitCode = exitCode;
    } catch (error: unknown) {
      logger.fatal({ err: error, reason }, "Process shutdown failed");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.once("uncaughtException", (error) => {
    logger.fatal({ err: error }, "Uncaught exception");
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (error) => {
    logger.fatal({ err: error }, "Unhandled rejection");
    void shutdown("unhandledRejection", 1);
  });

  try {
    await lifecycle.start();
    logger.info("Process started");
  } catch (error: unknown) {
    logger.fatal({ err: error }, "Process startup failed");
    await shutdown("startupFailure", 1);
  }
}
