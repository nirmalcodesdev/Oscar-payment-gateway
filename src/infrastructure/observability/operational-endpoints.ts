import type { Connection } from "mongoose";
import type { Redis } from "ioredis";
import { Queue } from "bullmq";
import type { Logger } from "pino";

import type { OperationalEndpoints } from "../../interfaces/http/create-app.js";
import type { RuntimeConfig } from "../../config/environment.js";
import { registerPersistenceModels } from "../mongodb/models.js";
import { ChainReadinessComponent } from "../lifecycle/chain-readiness.js";
import { apiMetrics, type GaugeValue } from "../metrics/registry.js";
import { RedisRateLimiter } from "../auth/rate-limiter.js";
import { ApplicationError } from "../../domain/errors/application-error.js";

/**
 * API-process operational endpoints (ADR 0016): the per-IP public rate
 * limiter (fail-open with an error log — a Redis outage must not drop
 * health/metrics), the Prometheus rendering with cross-process gauges from
 * MongoDB and Redis, and bounded readiness checks per enabled chain and
 * token (no provider identity in outcomes).
 */
export function buildOperationalEndpoints(
  connection: Connection,
  redis: Redis,
  config: RuntimeConfig,
  logger: Logger,
): OperationalEndpoints {
  const models = registerPersistenceModels(connection);
  const limiter = new RedisRateLimiter(redis);
  const chainReadiness = new ChainReadinessComponent(connection, config, logger);
  const queuePrefix = config.redis.queuePrefix;
  const queueNames = [
    "event-interpretation",
    "payment-confirmation",
    "webhook-delivery",
  ];
  const queues = queueNames.map(
    (name) =>
      new Queue(name, {
        prefix: queuePrefix,
        connection: redis,
        defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
      }),
  );

  return {
    publicRateLimit: (request, response, next) => {
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      limiter
        .consume(
          `oscar:rate:public:${remoteAddress}`,
          config.http.rateLimitPublicPerMinute,
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
          logger.error({ err: error }, "Public rate limiter unavailable; failing open");
          next();
        });
    },
    renderMetrics: async () => {
      const gauges: GaugeValue[] = [];
      for (const [status, count] of await paymentStatusCounts(models)) {
        gauges.push({
          name: "oscar_payments_by_status",
          help: "Payment documents by status",
          value: count,
          labelNames: ["status"],
          labelValues: [status],
        });
      }
      gauges.push({
        name: "oscar_compliance_holds",
        help: "Non-terminal payments held by screening",
        value: await models.Payment.countDocuments({
          status: { $in: ["pending", "matched", "confirming"] },
          screeningStatus: { $in: ["flagged", "blocked"] },
        }),
        labelNames: [],
        labelValues: [],
      });
      gauges.push({
        name: "oscar_webhook_dead_letter",
        help: "Dead-lettered webhook deliveries",
        value: await models.WebhookDelivery.countDocuments({ status: "dead_letter" }),
        labelNames: [],
        labelValues: [],
      });
      gauges.push({
        name: "oscar_reorg_records_total",
        help: "Recorded chain reorgs",
        value: await models.ReorgRecord.countDocuments({}),
        labelNames: [],
        labelValues: [],
      });
      gauges.push({
        name: "oscar_stuck_payments",
        help: "Matched/confirming payments beyond the staleness threshold",
        value: await models.Payment.countDocuments({
          status: { $in: ["matched", "confirming"] },
          updatedAt: {
            $lt: new Date(
              Date.now() - config.scheduler.stuckPaymentThresholdSec * 1000,
            ),
          },
        }),
        labelNames: [],
        labelValues: [],
      });
      for (const [index, queue] of queueNames.entries()) {
        const handle = queues[index];
        if (handle === undefined) continue;
        const counts = await handle.getJobCounts(
          "waiting",
          "delayed",
          "active",
          "failed",
        );
        gauges.push({
          name: "oscar_queue_lag",
          help: "Queue depth by state",
          value: counts["waiting"] ?? 0,
          labelNames: ["queue", "state"],
          labelValues: [queue, "waiting"],
        });
        gauges.push({
          name: "oscar_queue_lag",
          help: "Queue depth by state",
          value: counts["delayed"] ?? 0,
          labelNames: ["queue", "state"],
          labelValues: [queue, "delayed"],
        });
        gauges.push({
          name: "oscar_queue_lag",
          help: "Queue depth by state",
          value: counts["failed"] ?? 0,
          labelNames: ["queue", "state"],
          labelValues: [queue, "failed"],
        });
      }
      // Readiness gauges (cached probes) for the alert rules (ADR 0016).
      for (const check of await chainReadiness.checks()) {
        if (check.name.startsWith("chain:")) {
          gauges.push({
            name: "oscar_chain_ready",
            help: "At least one healthy provider for the enabled chain",
            value: check.ready ? 1 : 0,
            labelNames: ["chain"],
            labelValues: [check.name.slice("chain:".length)],
          });
        } else if (check.name.startsWith("token-decimals:")) {
          gauges.push({
            name: "oscar_token_decimals_ready",
            help: "Enabled token decimals verified and agreeing",
            value: check.ready ? 1 : 0,
            labelNames: ["token"],
            labelValues: [check.name.slice("token-decimals:".length)],
          });
        }
      }
      return apiMetrics.render(gauges);
    },
    readinessChecks: () => chainReadiness.checks(),
  };
}

async function paymentStatusCounts(
  models: ReturnType<typeof registerPersistenceModels>,
): Promise<readonly [string, number][]> {
  const results = await models.Payment.aggregate<{ _id: string; count: number }>([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  return results.map((entry) => [entry._id, entry.count]);
}
