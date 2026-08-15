import type { Logger } from "pino";

import { loadConfig, type ProcessName } from "../config/environment.js";
import { LifecycleManager } from "../infrastructure/lifecycle/lifecycle-manager.js";
import type { ManagedResource } from "../infrastructure/lifecycle/managed-resource.js";
import { ResourceReadinessProbe } from "../infrastructure/lifecycle/readiness-probe.js";
import { createLogger } from "../infrastructure/logging/logger.js";
import { MongoResource } from "../infrastructure/mongodb/mongo-resource.js";
import { RedisResource } from "../infrastructure/redis/redis-resource.js";
import { createApp } from "../interfaces/http/create-app.js";
import { createAdminRegistryRouter } from "../interfaces/http/admin-registry-router.js";
import { HttpServerResource } from "../interfaces/http/http-server-resource.js";
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

  if (processName !== "api") {
    return {
      logger,
      lifecycle: new LifecycleManager(dependencies, logger),
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
  const app = createApp(logger, new ResourceReadinessProbe(dependencies, logger), {
    apiRouters: [merchantSecurityRouter, adminRegistryRouter, paymentsRouter],
  });
  const httpServer = new HttpServerResource(app, config.api);
  return {
    logger,
    lifecycle: new LifecycleManager([...dependencies, httpServer], logger),
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  };
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
