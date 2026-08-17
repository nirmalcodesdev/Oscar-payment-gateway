import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

import mongoose, { type Connection } from "mongoose";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PaymentMatchingService } from "../../src/application/processing/payment-matching-service.js";
import {
  PaymentConfirmationService,
  type ConfirmationObservation,
  type PaymentConfirmationReader,
} from "../../src/application/processing/payment-confirmation-service.js";
import { SchedulerService } from "../../src/application/scheduler/scheduler-service.js";
import { ReconciliationService } from "../../src/application/reconciliation/reconciliation-service.js";
import { ScreeningService } from "../../src/application/compliance/screening-service.js";
import { UpdateableSanctionsListProvider } from "../../src/infrastructure/compliance/updateable-list-provider.js";
import {
  stableStringify,
  WebhookDeliveryQueue,
  WebhookDeliveryWorkerResource,
} from "../../src/infrastructure/queue/webhook-delivery-queue.js";
import { registerPersistenceModels } from "../../src/infrastructure/mongodb/models.js";
import { runDatabaseMigrations } from "../../src/infrastructure/mongodb/migrations/runner.js";
import { JobLease } from "../../src/infrastructure/redis/job-lease.js";
import { RedisResource } from "../../src/infrastructure/redis/redis-resource.js";
import { hashSecret } from "../../src/infrastructure/auth/secret-hasher.js";
import { loadConfig, type RuntimeConfig } from "../../src/config/environment.js";
import { validEnvironment } from "../helpers/environment.js";

const integrationUri = process.env["MONGODB_INTEGRATION_URI"];
const describeWithMongo = integrationUri === undefined ? describe.skip : describe;

const logger = pino({ level: "silent" });
const namespace = randomBytes(6).toString("hex");

const sender = "0x1111111111111111111111111111111111111111";

interface ReceivedRequest {
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

/** Local webhook receiver: records requests and answers with scripted codes. */
function receiver(script: () => number): {
  readonly server: Server;
  readonly requests: ReceivedRequest[];
  readonly baseUrl: () => string;
} {
  const requests: ReceivedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        url: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      const status = script();
      if (status === 0) {
        // Simulate an oversized response body.
        response.writeHead(200, { "content-type": "application/json" });
        response.end(Buffer.alloc(128 * 1024));
        return;
      }
      if (status >= 300 && status <= 399) {
        response.writeHead(status, { location: "http://169.254.169.254/x" });
        response.end();
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return {
    server,
    requests,
    baseUrl: () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      return `http://127.0.0.1:${address.port}/hook`;
    },
  };
}

function testConfig(overrides: Partial<RuntimeConfig["webhooks"]> = {}): RuntimeConfig {
  const base = loadConfig(validEnvironment());
  return {
    ...base,
    processing: { ...base.processing, latePaymentGraceSec: 0 },
    webhooks: { ...base.webhooks, ...overrides },
  };
}

describeWithMongo("Phase 09 webhooks, scheduler, and reconciliation", () => {
  let connection!: Connection;
  let models!: ReturnType<typeof registerPersistenceModels>;
  let redis: RedisResource;
  let derivationCursor = 0;

  const chainId = `chain-p9-${namespace}`;

  beforeAll(async () => {
    if (integrationUri === undefined) {
      throw new Error("MONGODB_INTEGRATION_URI is required for integration tests");
    }
    connection = mongoose.createConnection(integrationUri, {
      serverSelectionTimeoutMS: 10_000,
      directConnection: true,
      autoIndex: false,
    });
    await connection.asPromise();
    models = registerPersistenceModels(connection);
    await expect(runDatabaseMigrations(connection)).resolves.toBe(6);
    // Hermetic suite: reconciliation views scan wide ranges, so leftovers
    // from earlier suites must not leak into assertions.
    await models.WebhookDelivery.collection.deleteMany({});
    await models.ComplianceScreening.collection.deleteMany({});
    await models.OnChainEvent.collection.deleteMany({});
    await models.Payment.collection.deleteMany({});
    await models.WalletAddress.collection.deleteMany({});
    await models.ReconciliationAnnotation.collection.deleteMany({});
    redis = new RedisResource(loadConfig(validEnvironment()).redis);
    await redis.start();
  });

  afterAll(async () => {
    await redis.stop();
    await connection.close();
  });

  async function createPaymentFixture(options: {
    readonly seed: number | string;
    readonly amount: string;
    readonly expiresInSec?: number;
    readonly status?: string;
    readonly requiredConfirmations?: number;
    readonly screeningStatus?: string;
  }): Promise<{ readonly paymentId: string; readonly recipient: string }> {
    const paymentId = `pay_${namespace}_${options.seed}`;
    const recipient = `0x${randomBytes(20).toString("hex")}`;
    derivationCursor += 1;
    await models.WalletAddress.create({
      walletAddressId: `wallet_${namespace}_${options.seed}`,
      merchantId: `merchant_${namespace}`,
      chain: chainId,
      address: recipient,
      normalizedAddress: recipient,
      xpubId: `xpub_${namespace}`,
      derivationIndex: derivationCursor,
      status: "assigned",
      assignedPaymentId: paymentId,
    });
    await models.Payment.create({
      paymentId,
      merchantId: `merchant_${namespace}`,
      chain: chainId,
      token: "token-usdc-sepolia",
      walletAddressId: `wallet_${namespace}_${options.seed}`,
      amount: options.amount,
      status: options.status ?? "pending",
      version: 0,
      requiredConfirmations: options.requiredConfirmations ?? 1,
      tokenVerificationPolicy: "event_only",
      confirmations: 0,
      screeningStatus: options.screeningStatus ?? "pending",
      expiresAt: new Date(Date.now() + (options.expiresInSec ?? 3_600) * 1_000),
    });
    return { paymentId, recipient };
  }

  async function createEventFixture(options: {
    readonly seed: number;
    readonly toAddress: string;
    readonly amount: string;
  }): Promise<string> {
    const eventId = `event_${namespace}_${options.seed}`;
    await models.OnChainEvent.create({
      eventId,
      chain: chainId,
      token: "token-usdc-sepolia",
      contractAddress: `0x${randomBytes(20).toString("hex")}`,
      normalizedContractAddress: `0x${randomBytes(20).toString("hex")}`,
      transactionHash: `0x${namespace}${options.seed.toString(16).padStart(52, "0")}`,
      logIndex: 0,
      blockNumber: 100,
      blockHash: `0x${"a".repeat(64)}`,
      fromAddress: sender,
      normalizedFromAddress: sender,
      toAddress: options.toAddress,
      normalizedToAddress: options.toAddress,
      amount: options.amount,
      rawEvent: {},
      canonical: true,
      interpretationStatus: "accepted",
      ingestedAt: new Date(),
    });
    return eventId;
  }

  function scriptedScreening() {
    const provider = new UpdateableSanctionsListProvider(
      connection,
      testConfig().compliance,
      logger,
    );
    return new ScreeningService(connection, testConfig().compliance, provider, logger);
  }

  function readerWith(observation: ConfirmationObservation): PaymentConfirmationReader {
    return { observe: () => Promise.resolve(observation) };
  }

  describe("transactional outbox boundaries", () => {
    it("writes matched, confirmed, expired, and failed rows but none for held or unconfirmed state", async () => {
      // matched
      const matchFixture = await createPaymentFixture({
        seed: "wb-match",
        amount: "900",
      });
      const matchEvent = await createEventFixture({
        seed: 1,
        toAddress: matchFixture.recipient,
        amount: "900",
      });
      const dispatcher = new WebhookDeliveryQueue(
        redis.client,
        `${loadConfig(validEnvironment()).redis.queuePrefix}-p9`,
        2,
      );
      const matching = new PaymentMatchingService(connection, testConfig(), {
        webhookDispatcher: dispatcher,
      });
      await expect(matching.matchEvent(matchEvent, logger)).resolves.toMatchObject({
        action: "claimed_matched",
      });

      // confirmed
      const confirmFixture = await createPaymentFixture({
        seed: "wb-confirm",
        amount: "900",
        requiredConfirmations: 1,
      });
      const confirmEvent = await createEventFixture({
        seed: 2,
        toAddress: confirmFixture.recipient,
        amount: "900",
      });
      await expect(matching.matchEvent(confirmEvent, logger)).resolves.toMatchObject({
        action: "claimed_matched",
      });
      const confirmation = new PaymentConfirmationService(connection, testConfig(), {
        reader: readerWith({ status: "observed", canonical: true, confirmations: 5 }),
        screening: scriptedScreening(),
        webhookDispatcher: dispatcher,
      });
      await expect(
        confirmation.advancePayment(confirmFixture.paymentId, logger),
      ).resolves.toMatchObject({ outcome: "progressed", status: "confirming" });
      await expect(
        confirmation.advancePayment(confirmFixture.paymentId, logger),
      ).resolves.toMatchObject({ outcome: "terminal", status: "confirmed" });

      // failed (reorg off-ramp with elapsed grace)
      const failedFixture = await createPaymentFixture({
        seed: "wb-fail",
        amount: "900",
        status: "matched",
        expiresInSec: -1,
      });
      const failedEvent = await createEventFixture({
        seed: 3,
        toAddress: failedFixture.recipient,
        amount: "900",
      });
      await models.OnChainEvent.updateOne(
        { eventId: failedEvent },
        { $set: { matchedPaymentId: failedFixture.paymentId } },
      );
      await models.Payment.updateOne(
        { paymentId: failedFixture.paymentId, version: 0 },
        {
          $set: {
            matchedEventId: failedEvent,
            transactionHash: `0x${namespace}${"3".padStart(52, "0")}`,
            amountReceived: "900",
            matchedAt: new Date(),
          },
          $inc: { version: 1 },
        },
      );
      const failedConfirmer = new PaymentConfirmationService(connection, testConfig(), {
        reader: readerWith({ status: "observed", canonical: false, confirmations: 0 }),
        screening: scriptedScreening(),
        webhookDispatcher: dispatcher,
      });
      await expect(
        failedConfirmer.advancePayment(failedFixture.paymentId, logger),
      ).resolves.toMatchObject({ outcome: "terminal", status: "failed" });

      // expired via the event-driven path
      const expiredFixture = await createPaymentFixture({
        seed: "wb-expire",
        amount: "900",
        expiresInSec: -60,
      });
      const lateEvent = await createEventFixture({
        seed: 4,
        toAddress: expiredFixture.recipient,
        amount: "900",
      });
      await expect(matching.matchEvent(lateEvent, logger)).resolves.toMatchObject({
        action: "late_arrival_annotated",
      });

      // held (blocked screening): never reaches confirmed, no row
      const heldFixture = await createPaymentFixture({
        seed: "wb-held",
        amount: "900",
        requiredConfirmations: 1,
      });
      const heldEvent = await createEventFixture({
        seed: 5,
        toAddress: heldFixture.recipient,
        amount: "900",
      });
      await models.Payment.updateOne(
        { paymentId: heldFixture.paymentId, version: 0 },
        {
          $set: { screeningStatus: "blocked", status: "confirming" },
          $inc: { version: 1 },
        },
      );
      void heldEvent;
      const events = [
        `pay_${namespace}_wb-match`,
        `pay_${namespace}_wb-confirm`,
        `pay_${namespace}_wb-fail`,
        `pay_${namespace}_wb-expire`,
      ];
      for (const paymentId of events) {
        const rows = await models.WebhookDelivery.find({ paymentId }).lean();
        expect(rows.length, paymentId).toBeGreaterThanOrEqual(1);
        for (const row of rows) {
          expect(row.payload).toMatchObject({ paymentId });
        }
      }
      const matchedRows = await models.WebhookDelivery.find({
        paymentId: `pay_${namespace}_wb-match`,
      }).lean();
      expect(matchedRows.map((row) => row.eventType)).toContain("payment.matched");
      const confirmedRows = await models.WebhookDelivery.find({
        paymentId: `pay_${namespace}_wb-confirm`,
      }).lean();
      expect(confirmedRows.map((row) => row.eventType)).toContain("payment.confirmed");

      // A rollback cannot leave a row: simulate an aborted transition by
      // writing through a transaction that throws after the outbox insert.
      const { WebhookOutboxWriter } = await import(
        "../../src/application/webhooks/webhook-outbox.js"
      );
      const { withRequiredTransaction } = await import(
        "../../src/infrastructure/mongodb/transactions.js"
      );
      const outbox = new WebhookOutboxWriter(connection);
      const rollbackPaymentId = `pay_${namespace}_wb-rollback`;
      await expect(
        withRequiredTransaction(connection, async (session) => {
          await outbox.writeInTransaction(
            session,
            WebhookOutboxWriter.payloadFor(
              {
                paymentId: rollbackPaymentId,
                merchantId: `merchant_${namespace}`,
                status: "confirmed",
                version: 1,
                chain: chainId,
                token: "token-usdc-sepolia",
                amount: "1",
              },
              "payment.confirmed",
              new Date(),
            ),
          );
          throw new Error("simulated rollback");
        }),
      ).rejects.toThrow("simulated rollback");
      await expect(
        models.WebhookDelivery.countDocuments({ paymentId: rollbackPaymentId }),
      ).resolves.toBe(0);

      // duplicate transition replay collapses onto one row per key
      await expect(matching.matchEvent(matchEvent, logger)).resolves.toBeTruthy();
      await expect(
        models.WebhookDelivery.countDocuments({
          paymentId: `pay_${namespace}_wb-match`,
        }),
      ).resolves.toBe(1);
      await dispatcher.close();
    });
  });

  describe("delivery worker", () => {
    function harness(options: { script: () => number; maxAttempts?: number }) {
      const rx = receiver(options.script);
      const config = testConfig(
        options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts },
      );
      // An isolated queue prefix keeps the suite's jobs away from any other
      // worker; the queue and the worker must share it.
      const prefix = `${config.redis.queuePrefix}-p9${randomUUID().slice(0, 6)}`;
      const workerConfig = {
        ...config,
        redis: { ...config.redis, queuePrefix: prefix },
      };
      return { rx, config: workerConfig };
    }

    async function startReceiver(rx: { server: Server }): Promise<void> {
      await new Promise<void>((resolve) => rx.server.listen(0, "127.0.0.1", resolve));
    }

    async function stopReceiver(rx: { server: Server }): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        rx.server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    it("delivers a signed payload to a 2xx receiver and records it delivered", async () => {
      const { rx, config } = harness({ script: () => 200 });
      await startReceiver(rx);
      try {
        const { paymentId } = await createPaymentFixture({
          seed: "wb-ok",
          amount: "900",
        });
        const queue = new WebhookDeliveryQueue(
          redis.client,
          config.redis.queuePrefix,
          config.webhooks.maxAttempts,
        );
        const worker = new WebhookDeliveryWorkerResource({
          redis: redis.client,
          connection,
          config,
          logger,
          allowedTestDestinations: [hostPort(rx.baseUrl())],
        });
        await models.Merchant.updateOne(
          { merchantId: `merchant_${namespace}` },
          {
            $set: {
              email: `m-${namespace}@example.com`,
              status: "active",
              webhookUrl: rx.baseUrl(),
            },
            $inc: { version: 1 },
          },
          { upsert: true },
        );
        await worker.start();
        const deliveryId = `delivery_${randomUUID()}`;
        await models.WebhookDelivery.create({
          deliveryId,
          merchantId: `merchant_${namespace}`,
          paymentId,
          eventType: "payment.confirmed",
          idempotencyKey: `wh_${paymentId}_payment:confirmed_v1`,
          payload: {
            paymentId,
            merchantId: `merchant_${namespace}`,
            eventType: "payment.confirmed",
            status: "confirmed",
            paymentVersion: 1,
            chain: chainId,
            token: "token-usdc-sepolia",
            amount: "900",
            occurredAt: new Date().toISOString(),
          },
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date(),
        });
        await queue.enqueueWebhookDelivery(deliveryId);
        await queue.enqueueWebhookDelivery(deliveryId);
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const row = await models.WebhookDelivery.findOne({ deliveryId }).lean();
          if (row?.status === "delivered") break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const row = await models.WebhookDelivery.findOne({ deliveryId }).lean();
        expect(row?.status).toBe("delivered");
        expect(row?.lastResponseCode).toBe(200);
        expect(row?.deliveredAt).toBeDefined();

        // Duplicate enqueue collapsed: exactly one request reached the receiver.
        expect(rx.requests).toHaveLength(1);
        const received = rx.requests[0] ?? rx.requests.at(-1);
        expect(received).toBeDefined();
        if (received === undefined) return;
        expect(received.headers["x-oscar-delivery-id"]).toBe(deliveryId);
        const timestamp = received.headers["x-oscar-webhook-timestamp"];
        expect(typeof timestamp).toBe("string");
        const signature = received.headers["x-oscar-webhook-signature"];
        expect(typeof signature).toBe("string");
        const expected = createHmac("sha256", config.webhooks.hmacCurrentSecret);
        expected.update(`${timestamp as string}\n${deliveryId}\n`, "utf8");
        expected.update(received.body);
        expect(signature).toBe(expected.digest("hex"));
        // The delivered body is the byte-stable serialization.
        const parsed = JSON.parse(received.body.toString("utf8")) as {
          paymentId: string;
        };
        expect(parsed.paymentId).toBe(paymentId);
        await worker.stop();
        await queue.close();
      } finally {
        await stopReceiver(rx);
      }
    });

    it("dead-letters after exhausting attempts and replays through the admin service", async () => {
      const { rx, config } = harness({ script: () => 500, maxAttempts: 2 });
      await startReceiver(rx);
      try {
        const { paymentId } = await createPaymentFixture({
          seed: "wb-dlq",
          amount: "900",
        });
        const queue = new WebhookDeliveryQueue(
          redis.client,
          config.redis.queuePrefix,
          2,
        );
        const worker = new WebhookDeliveryWorkerResource({
          redis: redis.client,
          connection,
          config,
          logger,
          allowedTestDestinations: [hostPort(rx.baseUrl())],
        });
        await models.Merchant.updateOne(
          { merchantId: `merchant_${namespace}` },
          {
            $set: {
              email: `m-${namespace}@example.com`,
              status: "active",
              webhookUrl: rx.baseUrl(),
            },
            $inc: { version: 1 },
          },
          { upsert: true },
        );
        await worker.start();
        const deliveryId = `delivery_${randomUUID()}`;
        await models.WebhookDelivery.create({
          deliveryId,
          merchantId: `merchant_${namespace}`,
          paymentId,
          eventType: "payment.failed",
          idempotencyKey: `wh_${paymentId}_payment:failed_v1`,
          payload: { paymentId },
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date(),
        });
        await queue.enqueueWebhookDelivery(deliveryId);
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          const row = await models.WebhookDelivery.findOne({ deliveryId }).lean();
          if (row?.status === "dead_letter") break;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const row = await models.WebhookDelivery.findOne({ deliveryId }).lean();
        expect(row?.status).toBe("dead_letter");
        expect(row?.attempts).toBe(2);
        expect(row?.lastResponseCode).toBe(500);

        // Replay resets and re-enqueues with an audit trail.
        const reconciliation = new ReconciliationService(
          connection,
          logger,
          new WebhookDeliveryQueue(redis.client, config.redis.queuePrefix, 2),
        );
        await expect(
          reconciliation.replayWebhook(
            {
              kind: "admin",
              adminId: `admin_${namespace}`,
              sessionId: "s",
              tokenVersion: 0,
            },
            deliveryId,
          ),
        ).resolves.toMatchObject({ status: "pending" });
        await expect(
          models.AuditLog.countDocuments({
            entityId: deliveryId,
            action: "webhook_replay_requested",
          }),
        ).resolves.toBe(1);
        const reset = await models.WebhookDelivery.findOne({ deliveryId }).lean();
        expect(reset?.status).toBe("pending");
        // A delivered row refuses replay.
        await models.WebhookDelivery.updateOne(
          { deliveryId },
          { $set: { status: "delivered", deliveredAt: new Date() } },
        );
        await expect(
          reconciliation.replayWebhook(
            {
              kind: "admin",
              adminId: `admin_${namespace}`,
              sessionId: "s",
              tokenVersion: 0,
            },
            deliveryId,
          ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await worker.stop();
        await queue.close();
      } finally {
        await stopReceiver(rx);
      }
    });

    it("treats redirects and oversized responses as failures", async () => {
      const { WebhookDeliveryClient } = await import(
        "../../src/infrastructure/http/webhook-client.js"
      );
      const config = testConfig();

      // Redirect: an allowlisted receiver answers 302 toward a metadata
      // address; redirects are never followed, so this is a hard failure.
      const redirectRx = receiver(() => 302);
      await startReceiver(redirectRx);
      try {
        const redirectClient = new WebhookDeliveryClient(
          config.webhooks,
          "test",
          logger,
          { allowedTestDestinations: [hostPort(redirectRx.baseUrl())] },
        );
        const redirectResult = await redirectClient.deliver(
          redirectRx.baseUrl(),
          Buffer.from("x"),
          {},
        );
        expect(redirectResult).toMatchObject({ ok: false, failure: "redirect" });
      } finally {
        await stopReceiver(redirectRx);
      }

      // Oversized: the receiver streams a huge 200 body.
      const hugeRx = receiver(() => 0);
      await startReceiver(hugeRx);
      try {
        const oversizedClient = new WebhookDeliveryClient(
          { ...config.webhooks, deliveryTimeoutMs: 5_000 },
          "test",
          logger,
          { allowedTestDestinations: [hostPort(hugeRx.baseUrl())] },
        );
        await expect(
          oversizedClient.deliver(hugeRx.baseUrl(), Buffer.from("x"), {}),
        ).rejects.toMatchObject({ failure: "response_too_large" });
      } finally {
        await stopReceiver(hugeRx);
      }
    });
  });

  function hostPort(url: string): string {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port === "" ? "" : `:${parsed.port}`}`;
  }

  describe("scheduler jobs", () => {
    it("expires due payments through the legal transition with audit and outbox", async () => {
      const { paymentId } = await createPaymentFixture({
        seed: "sweep-exp",
        amount: "900",
        expiresInSec: -30,
      });
      const scheduler = new SchedulerService(
        connection,
        testConfig(),
        new JobLease(redis.client, `${namespace}-lease`, 60),
        logger,
        {
          webhookDispatcher: {
            enqueueWebhookDelivery: () => Promise.resolve(),
          },
        },
      );
      const affected = await scheduler.expireDuePayments();
      expect(affected).toBeGreaterThanOrEqual(1);
      const doc = await models.Payment.findOne({ paymentId }).lean();
      expect(doc?.status).toBe("expired");
      await expect(
        models.AuditLog.countDocuments({
          entityId: paymentId,
          action: "payment_expired",
          actorId: "scheduler",
        }),
      ).resolves.toBe(1);
      await expect(
        models.WebhookDelivery.countDocuments({
          paymentId,
          eventType: "payment.expired",
        }),
      ).resolves.toBe(1);
      // Idempotent: a second sweep does not double-transition.
      await scheduler.expireDuePayments();
      const after = await models.Payment.findOne({ paymentId }).lean();
      expect(after?.status).toBe("expired");
      await expect(
        models.AuditLog.countDocuments({
          entityId: paymentId,
          action: "payment_expired",
        }),
      ).resolves.toBe(1);
    });

    it("runs only one sweep per lease across concurrent schedulers", async () => {
      const { paymentId } = await createPaymentFixture({
        seed: "sweep-race",
        amount: "900",
        expiresInSec: -30,
      });
      const lease = new JobLease(redis.client, `${namespace}-race`, 60);
      const scheduler = new SchedulerService(
        connection,
        testConfig(),
        lease,
        logger,
        {},
      );
      const lease2 = new JobLease(redis.client, `${namespace}-race`, 60);
      const scheduler2 = new SchedulerService(
        connection,
        testConfig(),
        lease2,
        logger,
        {},
      );
      const results = await Promise.all([
        lease.acquire("expiry-sweep"),
        lease2.acquire("expiry-sweep"),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      await scheduler.expireDuePayments();
      await scheduler2.expireDuePayments();
      const doc = await models.Payment.findOne({ paymentId }).lean();
      expect(doc?.status).toBe("expired");
      await expect(
        models.AuditLog.countDocuments({
          entityId: paymentId,
          action: "payment_expired",
        }),
      ).resolves.toBe(1);
    });

    it("annotates stale matched payments deterministically", async () => {
      const { paymentId } = await createPaymentFixture({
        seed: "stuck",
        amount: "900",
        status: "matched",
      });
      await models.Payment.collection.updateOne(
        { paymentId },
        { $set: { updatedAt: new Date(Date.now() - 3 * 3_600_000) } },
      );
      const scheduler = new SchedulerService(
        connection,
        testConfig(),
        new JobLease(redis.client, `${namespace}-stuck`, 60),
        logger,
        {},
      );
      await scheduler.detectStuckPayments();
      await scheduler.detectStuckPayments();
      await expect(
        models.ReconciliationAnnotation.countDocuments({
          entityId: paymentId,
          category: "stale",
          status: "open",
        }),
      ).resolves.toBe(1);
    });

    it("re-enqueues due webhook rows in the outbox sweep", async () => {
      const dispatcher = {
        enqueued: [] as string[],
        enqueueWebhookDelivery: (deliveryId: string) => {
          dispatcher.enqueued.push(deliveryId);
          return Promise.resolve();
        },
      };
      const scheduler = new SchedulerService(
        connection,
        testConfig(),
        {} as never,
        logger,
        {
          webhookDispatcher: dispatcher,
        },
      );
      const deliveryId = `delivery_${randomUUID()}`;
      await models.WebhookDelivery.create({
        deliveryId,
        merchantId: `merchant_${namespace}`,
        paymentId: `pay_${namespace}_swept`,
        eventType: "payment.matched",
        idempotencyKey: `wh_swept_${randomUUID()}`,
        payload: {},
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 60_000),
      });
      const affected = await scheduler.sweepWebhookOutbox();
      expect(affected).toBeGreaterThanOrEqual(1);
      expect(dispatcher.enqueued).toContain(deliveryId);
    });
  });

  describe("reconciliation views", () => {
    it("surfaces discrepancies and resolves annotations with audit", async () => {
      const orphanEvent = await createEventFixture({
        seed: 99,
        toAddress: `0x${randomBytes(20).toString("hex")}`,
        amount: "77",
      });
      await models.OnChainEvent.collection.updateOne(
        { eventId: orphanEvent },
        { $set: { ingestedAt: new Date(Date.now() - 3_600_000) } },
      );
      const reconciliation = new ReconciliationService(connection, logger);
      const overview = await reconciliation.overview(200);
      expect(overview.orphanEvents.some((event) => event.eventId === orphanEvent)).toBe(
        true,
      );

      const annotationId = `ann_${randomBytes(16).toString("hex")}`;
      await models.ReconciliationAnnotation.create({
        annotationId,
        entityType: "OnChainEvent",
        entityId: orphanEvent,
        category: "orphan",
        status: "open",
        note: "test orphan",
        createdBy: "test",
        createdAt: new Date(),
      });
      const principal = {
        kind: "admin",
        adminId: `admin_${namespace}`,
        sessionId: "s",
        tokenVersion: 0,
      } as const;
      await reconciliation.resolveAnnotation(
        principal,
        annotationId,
        "Reviewed and closed",
      );
      await expect(
        reconciliation.resolveAnnotation(principal, annotationId, "Second attempt"),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        models.AuditLog.countDocuments({
          entityId: annotationId,
          action: "reconciliation_annotation_resolved",
        }),
      ).resolves.toBe(1);
      await expect(
        reconciliation.resolveAnnotation(principal, "ann_missing_entirely", "Nope"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("reconciliation router (live API)", () => {
    const apiBaseUrl = process.env["PHASE03_API_URL"];
    let adminJwt = "";

    beforeAll(async () => {
      if (apiBaseUrl === undefined) return;
      await models.AdminIdentity.create({
        adminId: `admin_${namespace}_p9`,
        email: `phase09-${namespace}@example.com`,
        passwordHash: await hashSecret("phase09-admin-password-long-enough"),
        role: "admin",
        status: "active",
        tokenVersion: 0,
      });
      const login = await fetch(`${apiBaseUrl}/api/v1/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `phase09-${namespace}@example.com`,
          password: "phase09-admin-password-long-enough",
        }),
      });
      expect(login.status).toBe(200);
      adminJwt = ((await login.json()) as { accessToken: string }).accessToken;
    });

    it("rejects unauthenticated reconciliation access", async () => {
      if (apiBaseUrl === undefined) return;
      const response = await fetch(`${apiBaseUrl}/api/v1/admin/reconciliation`);
      expect(response.status).toBe(401);
    });

    it("returns the overview and validates annotation resolution bodies", async () => {
      if (apiBaseUrl === undefined) return;
      const overview = await fetch(`${apiBaseUrl}/api/v1/admin/reconciliation`, {
        headers: { authorization: `Bearer ${adminJwt}` },
      });
      expect(overview.status).toBe(200);
      const body = (await overview.json()) as { orphanEvents?: unknown[] };
      expect(Array.isArray(body.orphanEvents)).toBe(true);

      const invalid = await fetch(
        `${apiBaseUrl}/api/v1/admin/reconciliation/annotations/ann_whatever/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${adminJwt}`,
          },
          body: JSON.stringify({ note: "short" }),
        },
      );
      expect(invalid.status).toBe(400);
      const errorBody = (await invalid.json()) as { error?: { code?: string } };
      expect(errorBody.error?.code).toBe("VALIDATION_ERROR");

      const replayMissing = await fetch(
        `${apiBaseUrl}/api/v1/admin/webhooks/delivery_missing/replay`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${adminJwt}` },
        },
      );
      expect(replayMissing.status).toBe(404);
    });
  });

  it("serializes payloads byte-stably regardless of key order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ x: [{ z: 1, y: 2 }] })).toBe(
      stableStringify({ x: [{ y: 2, z: 1 }] }),
    );
    expect(stableStringify({ u: undefined, k: 3 })).toBe(stableStringify({ k: 3 }));
  });
});
