import type { Logger } from "pino";

import { ComplianceService } from "../application/compliance/compliance-service.js";
import { ScreeningService } from "../application/compliance/screening-service.js";
import { EventInterpretationService } from "../application/ingestion/event-interpretation-service.js";
import { PaymentMatchingService } from "../application/processing/payment-matching-service.js";
import { PaymentConfirmationService } from "../application/processing/payment-confirmation-service.js";
import { SchedulerService } from "../application/scheduler/scheduler-service.js";
import { loadConfig, type ProcessName } from "../config/environment.js";
import { ApplicationError } from "../domain/errors/application-error.js";
import { EvmBalanceDeltaReader } from "../infrastructure/chain/evm-balance-delta-reader.js";
import { EvmConfirmationReader } from "../infrastructure/chain/evm-confirmation-reader.js";
import {
  resolveChainProviderClients,
  type ResolvedProviderClient,
} from "../infrastructure/chain/evm-chain-adapter.js";
import { UpdateableSanctionsListProvider } from "../infrastructure/compliance/updateable-list-provider.js";
import { buildOperationalEndpoints } from "../infrastructure/observability/operational-endpoints.js";
import { EnabledRegistryReader } from "../application/registry/registry-reader.js";
import { LifecycleManager } from "../infrastructure/lifecycle/lifecycle-manager.js";
import type { ManagedResource } from "../infrastructure/lifecycle/managed-resource.js";
import { ResourceReadinessProbe } from "../infrastructure/lifecycle/readiness-probe.js";
import { WatcherResource } from "../infrastructure/lifecycle/watcher-resource.js";
import { createLogger } from "../infrastructure/logging/logger.js";
import { MongoResource } from "../infrastructure/mongodb/mongo-resource.js";
import {
  PaymentConfirmationQueue,
  PaymentConfirmationWorkerResource,
} from "../infrastructure/queue/payment-confirmation-queue.js";
import { EventQueueResource } from "../infrastructure/queue/event-queue.js";
import { EventInterpretationWorkerResource } from "../infrastructure/queue/event-worker.js";
import {
  WebhookDeliveryQueue,
  WebhookDeliveryWorkerResource,
} from "../infrastructure/queue/webhook-delivery-queue.js";
import { JobLease } from "../infrastructure/redis/job-lease.js";
import { PaymentLock } from "../infrastructure/redis/payment-lock.js";
import { RedisRateLimiter } from "../infrastructure/auth/rate-limiter.js";
import { RedisResource } from "../infrastructure/redis/redis-resource.js";
import { createApp } from "../interfaces/http/create-app.js";
import { createAdminRegistryRouter } from "../interfaces/http/admin-registry-router.js";
import { createComplianceRouter } from "../interfaces/http/compliance-router.js";
import { createReconciliationRouter } from "../interfaces/http/reconciliation-router.js";
import { HttpServerResource } from "../interfaces/http/http-server-resource.js";
import { createInternalEventsRouter } from "../interfaces/http/internal-events-router.js";
import { createMerchantSecurityRouter } from "../interfaces/http/merchant-security-router.js";
import { createPaymentsRouter } from "../interfaces/http/payments-router.js";
import { createPublicRegistryRouter } from "../interfaces/http/public-registry-router.js";

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
    const webhookQueue = new WebhookDeliveryQueue(
      redis.client,
      config.redis.queuePrefix,
      config.webhooks.maxAttempts,
    );
    const confirmationQueue = new PaymentConfirmationQueue(
      redis.client,
      config.redis.queuePrefix,
      config.processing.confirmationPollIntervalMs,
    );
    const sanctionsProvider = new UpdateableSanctionsListProvider(
      mongo.connection,
      config.compliance,
      logger,
    );
    const scheduler = new SchedulerService(
      mongo.connection,
      config,
      new JobLease(
        redis.client,
        config.redis.queuePrefix,
        config.scheduler.leaseTtlSec,
      ),
      logger,
      { confirmations: confirmationQueue, webhookDispatcher: webhookQueue },
    );
    scheduler.bindScreeningRecheck(async () => {
      const compliance = new ComplianceService(
        mongo.connection,
        logger,
        sanctionsProvider,
      );
      const result = await compliance.rescreenHeldPayments();
      return result.cleared + result.stillHeld;
    });
    return {
      logger,
      lifecycle: new LifecycleManager(
        [
          ...dependencies,
          {
            name: "scheduler-jobs",
            start: () => Promise.resolve(scheduler.start()),
            stop: () => Promise.resolve(scheduler.stop()),
            isReady: () => Promise.resolve(true),
          } satisfies ManagedResource,
        ],
        logger,
      ),
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    };
  }

  if (processName === "watcher") {
    const watcher = new WatcherResource({
      connection: mongo.connection,
      config,
      logger,
      redis: redis.client,
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
    const confirmationReader = new EvmConfirmationReader(new Map(), logger);
    const providerSync = new BalanceDeltaProviderSync({
      config,
      readers: [balanceDeltas, confirmationReader],
      registryReader,
      logger,
      refreshSec: config.watcher.registryRefreshSec,
    });
    const confirmationQueue = new PaymentConfirmationQueue(
      redis.client,
      config.redis.queuePrefix,
      config.processing.confirmationPollIntervalMs,
    );
    const webhookQueue = new WebhookDeliveryQueue(
      redis.client,
      config.redis.queuePrefix,
      config.webhooks.maxAttempts,
    );
    const matching = new PaymentMatchingService(mongo.connection, config, {
      lock: new PaymentLock(redis.client, config.redis.queuePrefix),
      confirmations: confirmationQueue,
      webhookDispatcher: webhookQueue,
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
      matching,
    });
    const confirmationWorker = new PaymentConfirmationWorkerResource({
      redis: redis.client,
      queuePrefix: config.redis.queuePrefix,
      pollIntervalMs: config.processing.confirmationPollIntervalMs,
      service: new PaymentConfirmationService(mongo.connection, config, {
        reader: confirmationReader,
        screening: new ScreeningService(
          mongo.connection,
          config.compliance,
          new UpdateableSanctionsListProvider(
            mongo.connection,
            config.compliance,
            logger,
          ),
          logger,
        ),
        latestReviewDecision: (paymentId) =>
          new ComplianceService(mongo.connection, logger).latestDecision(paymentId),
        webhookDispatcher: webhookQueue,
      }),
      logger,
    });
    const webhookWorker = new WebhookDeliveryWorkerResource({
      redis: redis.client,
      connection: mongo.connection,
      config,
      logger,
    });
    return {
      logger,
      lifecycle: new LifecycleManager(
        [...dependencies, providerSync, worker, confirmationWorker, webhookWorker],
        logger,
      ),
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
  const sanctionsProvider = new UpdateableSanctionsListProvider(
    mongo.connection,
    config.compliance,
    logger,
  );
  const paymentsRouter = createPaymentsRouter({
    connection: mongo.connection,
    redis: redis.client,
    config,
    logger,
    screening: new ScreeningService(
      mongo.connection,
      config.compliance,
      sanctionsProvider,
      logger,
    ),
  });
  const complianceRouter = createComplianceRouter({
    connection: mongo.connection,
    redis: redis.client,
    config,
    logger,
    sanctionsProvider,
  });
  const webhookDispatchQueue = new WebhookDeliveryQueue(
    redis.client,
    config.redis.queuePrefix,
    config.webhooks.maxAttempts,
  );
  const reconciliationRouter = createReconciliationRouter({
    connection: mongo.connection,
    redis: redis.client,
    config,
    logger,
    webhookDispatcher: webhookDispatchQueue,
  });
  const eventQueue = new EventQueueResource(redis.client, config.redis.queuePrefix);
  const ingestionLimiter = new RedisRateLimiter(redis.client);
  const internalEventsRouter = createInternalEventsRouter({
    connection: mongo.connection,
    config,
    queue: eventQueue.queue,
    ingestionRateLimit: (request, _response, next) => {
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      ingestionLimiter
        .consume(
          `oscar:rate:ingestion:${remoteAddress}`,
          config.http.rateLimitIngestionPerMinute,
          60,
        )
        .then((decision) => {
          if (!decision.allowed) {
            next(
              new ApplicationError("RATE_LIMITED", "Too many requests", 429, {
                retryAfterSec: decision.retryAfterSec,
              }),
            );
            return;
          }
          next();
        })
        .catch((error: unknown) => {
          logger.error(
            { err: error },
            "Ingestion rate limiter unavailable; failing closed to HMAC",
          );
          next();
        });
    },
  });
  const app = createApp(logger, new ResourceReadinessProbe(dependencies, logger), {
    apiRouters: [
      merchantSecurityRouter,
      adminRegistryRouter,
      paymentsRouter,
      complianceRouter,
      reconciliationRouter,
      internalEventsRouter,
      createPublicRegistryRouter(mongo.connection),
    ],
    security: {
      corsAllowedOrigins: config.http.corsAllowedOrigins,
      ...(config.http.trustProxyHops === undefined
        ? {}
        : { trustProxyHops: config.http.trustProxyHops }),
    },
    operational: buildOperationalEndpoints(
      mongo.connection,
      redis.client,
      config,
      logger,
    ),
  });
  const httpServer = new HttpServerResource(app, config.api);
  return {
    logger,
    lifecycle: new LifecycleManager([...dependencies, eventQueue, httpServer], logger),
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  };
}

/**
 * Keeps the processor's corroborated chain readers in sync with the enabled
 * registry on a bounded interval (ADR 0010/0012). Provider configuration
 * failures degrade individual chains to "unavailable" reads (review outcome)
 * rather than failing processor startup.
 */
class BalanceDeltaProviderSync implements ManagedResource {
  public readonly name = "balance-delta-provider-sync";
  readonly #config: ReturnType<typeof loadConfig>;
  readonly #readers: {
    setProvidersByChain(
      providers: ReadonlyMap<string, readonly ResolvedProviderClient[]>,
    ): void;
  }[];
  readonly #registryReader: EnabledRegistryReader;
  readonly #logger: Logger;
  readonly #refreshSec: number;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;

  public constructor(options: {
    readonly config: ReturnType<typeof loadConfig>;
    readonly readers: {
      setProvidersByChain(
        providers: ReadonlyMap<string, readonly ResolvedProviderClient[]>,
      ): void;
    }[];
    readonly registryReader: EnabledRegistryReader;
    readonly logger: Logger;
    readonly refreshSec: number;
  }) {
    this.#config = options.config;
    this.#readers = options.readers;
    this.#registryReader = options.registryReader;
    this.#logger = options.logger.child({ component: "balance-delta-provider-sync" });
    this.#refreshSec = options.refreshSec;
  }

  public async start(): Promise<void> {
    await this.#sync();
    this.#timer = setInterval(() => {
      this.#inFlight ??= this.#sync()
        .catch((error: unknown) => {
          this.#logger.warn({ err: error }, "Chain reader provider sync failed");
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
          "Chain reader providers unresolved; chain reads will be unavailable",
        );
      }
    }
    for (const reader of this.#readers) {
      reader.setProvidersByChain(providersByChain);
    }
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
