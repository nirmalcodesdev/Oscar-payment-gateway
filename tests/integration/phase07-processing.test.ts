import { randomBytes } from "node:crypto";

import mongoose, { type Connection } from "mongoose";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ScreeningService } from "../../src/application/compliance/screening-service.js";
import { PaymentMatchingService } from "../../src/application/processing/payment-matching-service.js";
import {
  PaymentConfirmationService,
  type ConfirmationObservation,
  type PaymentConfirmationReader,
} from "../../src/application/processing/payment-confirmation-service.js";
import { ReorgResolutionService } from "../../src/application/watcher/reorg-resolution-service.js";
import type { SanctionsScreeningProvider } from "../../src/domain/compliance/screening-provider.js";
import type {
  BlockHeaderCorroborator,
  ChainObservationPort,
  ObservedBlockHeader,
} from "../../src/domain/chain/chain-adapter.js";
import { erc20TransferTopic } from "../../src/infrastructure/chain/evm-registry-verifier.js";
import { MongoChainCursorStorage } from "../../src/infrastructure/chain/mongo-cursor-storage.js";
import { registerPersistenceModels } from "../../src/infrastructure/mongodb/models.js";
import { runDatabaseMigrations } from "../../src/infrastructure/mongodb/migrations/runner.js";
import { PaymentLock } from "../../src/infrastructure/redis/payment-lock.js";
import { RedisResource } from "../../src/infrastructure/redis/redis-resource.js";
import { loadConfig, type RuntimeConfig } from "../../src/config/environment.js";
import { validEnvironment } from "../helpers/environment.js";

const integrationUri = process.env["MONGODB_INTEGRATION_URI"];
const describeWithMongo = integrationUri === undefined ? describe.skip : describe;

const logger = pino({ level: "silent" });
const namespace = randomBytes(6).toString("hex");

const chainId = "ethereum-sepolia";
const contractAddress = "0xcccccccccccccccccccccccccccccccccccccc01";
const sender = "0x1111111111111111111111111111111111111111";
const sanctionedSender = "0xD78523784b3A8e5c21D026eE7Fe405C39D1542ac";

const hashOf = (blockNumber: number): string =>
  `0x${blockNumber.toString(16).padStart(64, "0")}`;
const rehashOf = (blockNumber: number, salt: number): string =>
  `0x${(blockNumber * 31 + salt).toString(16).padStart(64, "0")}`;
const txOf = (seed: number): string =>
  `0x${namespace}${seed.toString(16).padStart(52, "0")}`;
const topicAddress = (address: string): string =>
  `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const wordAmount = (amount: bigint): string =>
  `0x${amount.toString(16).padStart(64, "0")}`;

function transferRaw(from: string, to: string, amount: bigint) {
  return {
    topics: [erc20TransferTopic, topicAddress(from), topicAddress(to)],
    data: wordAmount(amount),
  };
}

/** Config clone with tunable processing knobs (grace windows shrink to zero). */
function testConfig(
  overrides: Partial<RuntimeConfig["processing"]> = {},
): RuntimeConfig {
  const base = loadConfig(validEnvironment());
  return {
    ...base,
    processing: { ...base.processing, latePaymentGraceSec: 0, ...overrides },
  };
}

describeWithMongo("Phase 07 payment processing", () => {
  let connection!: Connection;
  let models!: ReturnType<typeof registerPersistenceModels>;
  let derivationCursor = 0;

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
    // Hermetic suite: unexpired screening cache records from other runs must
    // not leak into the scripted screening assertions.
    await models.ComplianceScreening.collection.deleteMany({});
  });

  afterAll(async () => {
    await connection.close();
  });

  function paymentFixtureId(seed: number | string): string {
    return `pay_${namespace}_${seed}`;
  }

  async function createPaymentFixture(options: {
    readonly seed: number | string;
    readonly amount: string;
    readonly expiresInSec?: number;
    readonly status?: string;
    readonly requiredConfirmations?: number;
    readonly matchedEventId?: string;
    readonly transactionHash?: string;
    readonly screeningStatus?: string;
  }): Promise<{ readonly paymentId: string; readonly recipient: string }> {
    const paymentId = paymentFixtureId(options.seed);
    const recipient = `0x${randomBytes(20).toString("hex")}`;
    const walletAddressId = `wallet_${namespace}_${options.seed}`;
    await models.WalletAddress.create({
      walletAddressId,
      merchantId: `merchant_${namespace}`,
      chain: chainId,
      address: recipient,
      normalizedAddress: recipient.toLowerCase(),
      xpubId: `xpub_${namespace}`,
      derivationIndex: (derivationCursor += 1),
      status: "assigned",
      assignedPaymentId: paymentId,
    });
    await models.Payment.create({
      paymentId,
      merchantId: `merchant_${namespace}`,
      chain: chainId,
      token: "token-usdc-sepolia",
      walletAddressId,
      amount: options.amount,
      status: options.status ?? "pending",
      version: 0,
      requiredConfirmations: options.requiredConfirmations ?? 2,
      tokenVerificationPolicy: "event_only",
      confirmations: 0,
      screeningStatus: options.screeningStatus ?? "pending",
      expiresAt: new Date(Date.now() + (options.expiresInSec ?? 3_600) * 1_000),
      ...(options.matchedEventId === undefined
        ? {}
        : { matchedEventId: options.matchedEventId }),
      ...(options.transactionHash === undefined
        ? {}
        : { transactionHash: options.transactionHash }),
    });
    return { paymentId, recipient };
  }

  async function createEventFixture(options: {
    readonly seed: number | string;
    readonly toAddress: string;
    readonly amount: string;
    readonly blockNumber?: number;
    readonly fromAddress?: string;
    readonly token?: string;
    readonly canonical?: boolean;
    readonly interpretationStatus?: string;
    readonly chain?: string;
  }): Promise<string> {
    const eventId = `event_${namespace}_${options.seed}`;
    const from = options.fromAddress ?? sender;
    await models.OnChainEvent.create({
      eventId,
      chain: options.chain ?? chainId,
      token: options.token ?? "token-usdc-sepolia",
      contractAddress,
      normalizedContractAddress: contractAddress,
      transactionHash: txOf(Number(options.seed)),
      logIndex: 0,
      blockNumber: options.blockNumber ?? 100,
      blockHash: hashOf(options.blockNumber ?? 100),
      fromAddress: from,
      normalizedFromAddress: from.toLowerCase(),
      toAddress: options.toAddress,
      normalizedToAddress: options.toAddress.toLowerCase(),
      amount: options.amount,
      rawEvent: transferRaw(from, options.toAddress, BigInt(options.amount)),
      canonical: options.canonical ?? true,
      interpretationStatus: options.interpretationStatus ?? "accepted",
      ingestedAt: new Date(),
    });
    return eventId;
  }

  function recordingEnqueuer(): {
    readonly enqueued: string[];
    readonly enqueuer: { enqueueConfirmation(paymentId: string): Promise<void> };
  } {
    const enqueued: string[] = [];
    return {
      enqueued,
      enqueuer: {
        enqueueConfirmation: (paymentId) => {
          enqueued.push(paymentId);
          return Promise.resolve();
        },
      },
    };
  }

  async function paymentDoc(paymentId: string) {
    const doc = await models.Payment.findOne({ paymentId }).lean();
    expect(doc).not.toBeNull();
    return doc as unknown as Record<string, unknown>;
  }

  describe("matching and claiming", () => {
    it("matches an exact qualifying event and enqueues confirmation", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "exact",
        amount: "900",
      });
      const eventId = await createEventFixture({
        seed: 1,
        toAddress: recipient,
        amount: "900",
      });
      const { enqueued, enqueuer } = recordingEnqueuer();
      const service = new PaymentMatchingService(connection, testConfig(), {
        confirmations: enqueuer,
      });

      const outcome = await service.matchEvent(eventId, logger);
      expect(outcome).toEqual({
        eventId,
        action: "claimed_matched",
        paymentId,
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("matched");
      expect(doc["amountReceived"]).toBe("900");
      expect(doc["matchedEventId"]).toBe(eventId);
      expect(doc["overpaymentFlag"]).toBe(false);
      expect(enqueued).toEqual([paymentId]);
      const claimed = await models.OnChainEvent.findOne({ eventId }).lean();
      expect((claimed as unknown as Record<string, unknown>)["matchedPaymentId"]).toBe(
        paymentId,
      );
      const audits = await models.AuditLog.countDocuments({
        entityId: paymentId,
        action: "payment_matched",
      });
      expect(audits).toBe(1);
    });

    it("accumulates partial transfers without matching early", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "partial",
        amount: "1000",
      });
      const service = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });

      const first = await createEventFixture({
        seed: 2,
        toAddress: recipient,
        amount: "400",
      });
      await expect(service.matchEvent(first, logger)).resolves.toMatchObject({
        action: "claimed_partial",
      });
      let doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("pending");
      expect(doc["partialAmountReceived"]).toBe("400");
      expect(doc["underpaymentFlag"]).toBe(true);

      const second = await createEventFixture({
        seed: 3,
        toAddress: recipient,
        amount: "300",
      });
      await expect(service.matchEvent(second, logger)).resolves.toMatchObject({
        action: "claimed_partial",
      });
      doc = await paymentDoc(paymentId);
      expect(doc["partialAmountReceived"]).toBe("700");
      expect(doc["status"]).toBe("pending");

      const completing = await createEventFixture({
        seed: 4,
        toAddress: recipient,
        amount: "300",
      });
      await expect(service.matchEvent(completing, logger)).resolves.toMatchObject({
        action: "claimed_matched",
      });
      doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("matched");
      expect(doc["amountReceived"]).toBe("1000");
      expect(doc["matchedEventId"]).toBe(completing);
      expect(doc["underpaymentFlag"]).toBe(false);
      await expect(
        models.OnChainEvent.countDocuments({ matchedPaymentId: paymentId }),
      ).resolves.toBe(3);
    });

    it("records overpayment excess explicitly and surfaces it", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "over",
        amount: "500",
      });
      const eventId = await createEventFixture({
        seed: 5,
        toAddress: recipient,
        amount: "800",
      });
      const service = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });

      await expect(service.matchEvent(eventId, logger)).resolves.toMatchObject({
        action: "claimed_matched",
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["amountReceived"]).toBe("800");
      expect(doc["excessAmount"]).toBe("300");
      expect(doc["overpaymentFlag"]).toBe(true);
      await expect(
        models.ReconciliationAnnotation.countDocuments({
          entityType: "Payment",
          entityId: paymentId,
          category: "excess",
          status: "open",
        }),
      ).resolves.toBe(1);
    });

    it("leaves over-amount deposits unclaimed when tolerance is disabled", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "notoler",
        amount: "500",
      });
      const eventId = await createEventFixture({
        seed: 6,
        toAddress: recipient,
        amount: "900",
      });
      const service = new PaymentMatchingService(
        connection,
        testConfig({ overpaymentAllow: false }),
        { confirmations: recordingEnqueuer().enqueuer },
      );

      await expect(service.matchEvent(eventId, logger)).resolves.toMatchObject({
        action: "skipped",
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("pending");
      const claimed = await models.OnChainEvent.findOne({ eventId }).lean();
      expect(
        (claimed as unknown as Record<string, unknown>)["matchedPaymentId"],
      ).toBeUndefined();
      await expect(
        models.ReconciliationAnnotation.countDocuments({
          entityType: "OnChainEvent",
          entityId: eventId,
          category: "excess",
        }),
      ).resolves.toBe(1);
    });

    it("collapses duplicate delivery of the same transfer onto one claim", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "dupe",
        amount: "900",
      });
      const eventId = await createEventFixture({
        seed: 7,
        toAddress: recipient,
        amount: "900",
      });
      const service = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });

      await expect(service.matchEvent(eventId, logger)).resolves.toMatchObject({
        action: "claimed_matched",
      });
      await expect(service.matchEvent(eventId, logger)).resolves.toMatchObject({
        action: "excess_linked",
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("matched");
      expect(doc["amountReceived"]).toBe("900");
      await expect(
        models.OnChainEvent.countDocuments({ matchedPaymentId: paymentId }),
      ).resolves.toBe(1);
    });

    it("routes late arrivals to manual reconciliation without auto-credit", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "late",
        amount: "900",
        expiresInSec: -60,
      });
      const eventId = await createEventFixture({
        seed: 8,
        toAddress: recipient,
        amount: "900",
      });
      const service = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });

      await expect(service.matchEvent(eventId, logger)).resolves.toMatchObject({
        action: "late_arrival_annotated",
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("expired");
      expect(doc["amountReceived"]).toBeUndefined();
      const claimed = await models.OnChainEvent.findOne({ eventId }).lean();
      expect(
        (claimed as unknown as Record<string, unknown>)["matchedPaymentId"],
      ).toBeUndefined();
      await expect(
        models.ReconciliationAnnotation.countDocuments({
          entityId: eventId,
          category: "late",
        }),
      ).resolves.toBe(1);
    });

    it("holds expired partial payments for refund review", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "latepartial",
        amount: "900",
        expiresInSec: -60,
      });
      const partial = await createEventFixture({
        seed: 9,
        toAddress: recipient,
        amount: "400",
      });
      // The partial was claimed while the payment was open; only the
      // completion is late. Seed the historical claim directly.
      await models.OnChainEvent.updateOne(
        { eventId: partial },
        { $set: { matchedPaymentId: paymentId } },
      );
      await models.Payment.updateOne(
        { paymentId, version: 0 },
        {
          $set: { partialAmountReceived: "400", underpaymentFlag: true },
          $inc: { version: 1 },
        },
      );
      const service = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });

      const lateCompletion = await createEventFixture({
        seed: 10,
        toAddress: recipient,
        amount: "500",
      });
      await expect(service.matchEvent(lateCompletion, logger)).resolves.toMatchObject({
        action: "late_arrival_annotated",
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("expired");
      expect(doc["partialAmountReceived"]).toBe("400");
      await expect(
        models.ReconciliationAnnotation.countDocuments({
          entityType: "Payment",
          entityId: paymentId,
          category: "partial",
        }),
      ).resolves.toBe(1);
    });

    it("annotates deposits with no assigned payment as orphans", async () => {
      const stranger = `0x${randomBytes(20).toString("hex")}`;
      const eventId = await createEventFixture({
        seed: 11,
        toAddress: stranger,
        amount: "100",
      });
      const service = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });
      await expect(service.matchEvent(eventId, logger)).resolves.toMatchObject({
        action: "orphan_annotated",
      });
      await expect(
        models.ReconciliationAnnotation.countDocuments({
          entityId: eventId,
          category: "orphan",
        }),
      ).resolves.toBe(1);
    });

    it("never matches on recipient alone when the token identity differs", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "wrongtoken",
        amount: "900",
      });
      const eventId = await createEventFixture({
        seed: 12,
        toAddress: recipient,
        amount: "900",
        token: "token-other-sepolia",
      });
      const service = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });
      await expect(service.matchEvent(eventId, logger)).resolves.toMatchObject({
        action: "orphan_annotated",
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("pending");
    });

    it("skips non-accepted and non-canonical events", async () => {
      const { recipient } = await createPaymentFixture({
        seed: "skipevents",
        amount: "900",
      });
      const rejected = await createEventFixture({
        seed: 13,
        toAddress: recipient,
        amount: "900",
        interpretationStatus: "rejected",
      });
      const orphaned = await createEventFixture({
        seed: 14,
        toAddress: recipient,
        amount: "900",
        canonical: false,
      });
      const service = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });
      await expect(service.matchEvent(rejected, logger)).resolves.toMatchObject({
        action: "skipped",
      });
      await expect(service.matchEvent(orphaned, logger)).resolves.toMatchObject({
        action: "skipped",
      });
    });
  });

  describe("competing workers", () => {
    it("settles exactly one claim and outcome across concurrent matchers", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "race",
        amount: "900",
      });
      const eventId = await createEventFixture({
        seed: 15,
        toAddress: recipient,
        amount: "900",
      });
      const redisResource = new RedisResource(loadConfig(validEnvironment()).redis);
      await redisResource.start();
      try {
        const outcomes = await Promise.all(
          Array.from({ length: 8 }, (_, index) => {
            const service = new PaymentMatchingService(connection, testConfig(), {
              lock: new PaymentLock(
                redisResource.client,
                `oscar-test-${namespace}-${index}`,
              ),
              confirmations: recordingEnqueuer().enqueuer,
            });
            return service.matchEvent(eventId, logger);
          }),
        );
        const matched = outcomes.filter(
          (outcome) => outcome.action === "claimed_matched",
        );
        expect(matched).toHaveLength(1);
        const doc = await paymentDoc(paymentId);
        expect(doc["status"]).toBe("matched");
        expect(doc["amountReceived"]).toBe("900");
        // Losers collapse onto idempotent re-links, each of which is a
        // legitimate audited write; only the single matched transition exists.
        expect(doc["version"]).toBe(8);
        await expect(
          models.OnChainEvent.countDocuments({ matchedPaymentId: paymentId }),
        ).resolves.toBe(1);
        await expect(
          models.AuditLog.countDocuments({
            entityId: paymentId,
            action: "payment_matched",
          }),
        ).resolves.toBe(1);
      } finally {
        await redisResource.stop();
      }
    });

    it("keeps one effective outcome when duplicate transfers race to complete", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "racecomplete",
        amount: "900",
      });
      const first = await createEventFixture({
        seed: 16,
        toAddress: recipient,
        amount: "900",
      });
      const second = await createEventFixture({
        seed: 17,
        toAddress: recipient,
        amount: "900",
      });
      const services = Array.from(
        { length: 4 },
        () =>
          new PaymentMatchingService(connection, testConfig(), {
            confirmations: recordingEnqueuer().enqueuer,
          }),
      );
      const jobs: ReturnType<PaymentMatchingService["matchEvent"]>[] = [];
      let toggle = 0;
      for (const service of services) {
        jobs.push(service.matchEvent(toggle % 2 === 0 ? first : second, logger));
        toggle += 1;
      }
      const outcomes = await Promise.all(jobs);
      expect(
        outcomes.filter((outcome) => outcome.action === "claimed_matched"),
      ).toHaveLength(1);
      const doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("matched");
      expect(doc["amountReceived"]).toBe("1800");
      expect(doc["excessAmount"]).toBe("900");
      await expect(
        models.OnChainEvent.countDocuments({ matchedPaymentId: paymentId }),
      ).resolves.toBe(2);
    });
  });

  describe("confirmation progression", () => {
    function scriptedReader(): {
      readonly reader: PaymentConfirmationReader;
      set(observation: ConfirmationObservation): void;
    } {
      let current: ConfirmationObservation = {
        status: "observed",
        canonical: true,
        confirmations: 0,
      };
      return {
        reader: {
          observe: () => Promise.resolve(current),
        },
        set: (observation) => {
          current = observation;
        },
      };
    }

    function scriptedScreening(
      verdict: "clear" | "blocked" | "unavailable",
    ): SanctionsScreeningProvider {
      // Wrapped in the real screening facade so record-keeping matches
      // production (ADR 0013); the facade dedupes via its cache.
      const scripted: SanctionsScreeningProvider = {
        screen: () =>
          Promise.resolve({
            verdict,
            riskLevel: verdict === "clear" ? "clear" : "blocked",
            sanctioned: verdict === "blocked",
            provider: "scripted",
            providerVersion: "scripted-v1",
            listVersion: "scripted-list-v1",
            rawResponse: {},
          }),
      };
      return new ScreeningService(
        connection,
        testConfig().compliance,
        scripted,
        logger,
      );
    }

    it("walks matched through confirming to a capped confirmed terminal", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "confirm",
        amount: "900",
        requiredConfirmations: 3,
      });
      const eventId = await createEventFixture({
        seed: 18,
        toAddress: recipient,
        amount: "900",
      });
      const matcher = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });
      await matcher.matchEvent(eventId, logger);

      const reader = scriptedReader();
      const service = new PaymentConfirmationService(connection, testConfig(), {
        reader: reader.reader,
        screening: scriptedScreening("clear"),
      });

      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "progressed",
        status: "confirming",
      });
      let doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("confirming");

      reader.set({ status: "observed", canonical: true, confirmations: 2 });
      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "progressed",
      });
      doc = await paymentDoc(paymentId);
      expect(doc["confirmations"]).toBe(2);

      reader.set({ status: "observed", canonical: true, confirmations: 99 });
      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "terminal",
        status: "confirmed",
      });
      doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("confirmed");
      expect(doc["confirmations"]).toBe(3);
      expect(doc["screeningStatus"]).toBe("clear");
      await expect(
        models.AuditLog.countDocuments({
          entityId: paymentId,
          action: "payment_confirmed",
        }),
      ).resolves.toBe(1);
      const screeningCount = await models.ComplianceScreening.countDocuments({
        normalizedAddress: sender,
      });
      expect(screeningCount).toBe(1);

      // Terminal: further advances are harmless.
      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "terminal",
      });
    });

    it("audits only confirming self-loops that increase the count", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "selfloop",
        amount: "900",
        requiredConfirmations: 5,
      });
      const eventId = await createEventFixture({
        seed: 19,
        toAddress: recipient,
        amount: "900",
      });
      const matcher = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });
      await matcher.matchEvent(eventId, logger);
      const reader = scriptedReader();
      const service = new PaymentConfirmationService(connection, testConfig(), {
        reader: reader.reader,
        screening: scriptedScreening("clear"),
      });

      reader.set({ status: "observed", canonical: true, confirmations: 1 });
      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "progressed",
        status: "confirming",
      });
      reader.set({ status: "observed", canonical: true, confirmations: 2 });
      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "progressed",
      });
      // No progress: not a transition, just a waiting poll.
      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "waiting",
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["confirmations"]).toBe(2);
    });

    it("holds confirmation for a blocked sender without a terminal transition", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "blocked",
        amount: "900",
        requiredConfirmations: 1,
      });
      const eventId = await createEventFixture({
        seed: 20,
        toAddress: recipient,
        amount: "900",
        fromAddress: sanctionedSender,
      });
      const matcher = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });
      await matcher.matchEvent(eventId, logger);
      const reader = scriptedReader();
      const service = new PaymentConfirmationService(connection, testConfig(), {
        reader: reader.reader,
        screening: scriptedScreening("blocked"),
      });

      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "progressed",
        status: "confirming",
      });
      reader.set({ status: "observed", canonical: true, confirmations: 10 });
      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "held",
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("confirming");
      expect(doc["screeningStatus"]).toBe("blocked");
      await expect(
        models.ReconciliationAnnotation.countDocuments({
          entityId: paymentId,
          category: "compliance",
        }),
      ).resolves.toBe(1);
    });

    it("fails closed when the confirmation observation is unavailable", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "unavail",
        amount: "900",
      });
      const eventId = await createEventFixture({
        seed: 21,
        toAddress: recipient,
        amount: "900",
      });
      const matcher = new PaymentMatchingService(connection, testConfig(), {
        confirmations: recordingEnqueuer().enqueuer,
      });
      await matcher.matchEvent(eventId, logger);
      const reader = scriptedReader();
      reader.set({ status: "unavailable" });
      const service = new PaymentConfirmationService(connection, testConfig(), {
        reader: reader.reader,
        screening: scriptedScreening("clear"),
      });
      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "waiting",
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("matched");
    });

    it("fails a payment only after the reorg grace elapses with no replacement", async () => {
      // A matched payment whose expiry and zero-length grace have both
      // elapsed, seeded directly because matching itself would expire it.
      const eventId = `event_${namespace}_22`;
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "reorgfail",
        amount: "900",
        expiresInSec: -1,
        status: "matched",
        matchedEventId: eventId,
        transactionHash: txOf(22),
      });
      await createEventFixture({
        seed: 22,
        toAddress: recipient,
        amount: "900",
      });
      await models.OnChainEvent.updateOne(
        { eventId },
        { $set: { matchedPaymentId: paymentId } },
      );
      await models.Payment.updateOne(
        { paymentId, version: 0 },
        {
          $set: { amountReceived: "900", matchedAt: new Date(Date.now() - 120_000) },
          $inc: { version: 1 },
        },
      );

      const reader = scriptedReader();
      const service = new PaymentConfirmationService(
        connection,
        testConfig({ latePaymentGraceSec: 0 }),
        { reader: reader.reader, screening: scriptedScreening("clear") },
      );
      reader.set({ status: "observed", canonical: false, confirmations: 0 });
      await expect(service.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "terminal",
        status: "failed",
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["status"]).toBe("failed");
      await expect(
        models.ReconciliationAnnotation.countDocuments({
          entityId: paymentId,
          category: "reorg",
        }),
      ).resolves.toBe(1);
      await expect(
        models.AuditLog.countDocuments({
          entityId: paymentId,
          action: "payment_failed",
        }),
      ).resolves.toBe(1);
    });
  });

  describe("reorg resolution", () => {
    const reorgChain = `chain-reorg-${namespace}`;
    const storage = () => new MongoChainCursorStorage(connection, reorgChain);

    function header(blockNumber: number, salt = 0): ObservedBlockHeader {
      return {
        blockNumber,
        blockHash: salt === 0 ? hashOf(blockNumber) : rehashOf(blockNumber, salt),
        parentHash:
          blockNumber === 0
            ? `0x${"0".repeat(64)}`
            : salt === 0
              ? hashOf(blockNumber - 1)
              : rehashOf(blockNumber - 1, salt),
      };
    }

    function fakeObservation(live: readonly ObservedBlockHeader[]): {
      readonly observation: ChainObservationPort;
      readonly corroborator: BlockHeaderCorroborator;
      readonly setCorroboration: (
        value: "agreeing" | "disagreement" | "unavailable",
      ) => void;
    } {
      let corroboration: "agreeing" | "disagreement" | "unavailable" = "agreeing";
      return {
        observation: {
          getCurrentBlock: () =>
            Promise.resolve(live[live.length - 1]?.blockNumber ?? 0),
          getBlockHeader: (blockNumber) => {
            const found = live.find((h) => h.blockNumber === blockNumber);
            return found === undefined
              ? Promise.reject(new Error(`no live header for ${blockNumber}`))
              : Promise.resolve(found);
          },
          getLogs: () => Promise.resolve([]),
          getBlockTransactions: () => Promise.resolve([]),
        },
        corroborator: {
          corroborateBlockHeader: () => Promise.resolve(corroboration),
        },
        setCorroboration: (value) => {
          corroboration = value;
        },
      };
    }

    async function seedBlocks(toBlock: number): Promise<void> {
      await storage().bootstrap(header(0));
      for (let block = 1; block <= toBlock; block += 1) {
        const cursor = await storage().read();
        if (cursor === undefined) throw new Error("cursor vanished");
        await storage().advance({
          expectedVersion: cursor.version,
          lastProcessedBlock: block,
          lastProcessedBlockHash: header(block).blockHash,
          headers: [header(block)],
        });
      }
    }

    it("rewinds the cursor, preserves history, and resolves payments", async () => {
      await seedBlocks(5);
      // Payments anchored to blocks 4 (pending partial), 4 (matched), 4 (confirmed).
      const pendingFixture = await createPaymentFixture({
        seed: "reorgpending",
        amount: "1000",
      });
      const matchedFixture = await createPaymentFixture({
        seed: "reorgmatched",
        amount: "900",
        status: "matched",
      });
      const confirmedFixture = await createPaymentFixture({
        seed: "reorgconfirmed",
        amount: "900",
        status: "confirmed",
        screeningStatus: "clear",
      });
      const partialEvent = await createEventFixture({
        seed: 30,
        toAddress: pendingFixture.recipient,
        amount: "400",
        blockNumber: 4,
        chain: reorgChain,
      });
      const matchedEvent = await createEventFixture({
        seed: 31,
        toAddress: matchedFixture.recipient,
        amount: "900",
        blockNumber: 4,
        chain: reorgChain,
      });
      const confirmedEvent = await createEventFixture({
        seed: 32,
        toAddress: confirmedFixture.recipient,
        amount: "900",
        blockNumber: 4,
        chain: reorgChain,
      });
      await models.OnChainEvent.updateOne(
        { eventId: partialEvent },
        { $set: { matchedPaymentId: pendingFixture.paymentId } },
      );
      await models.OnChainEvent.updateOne(
        { eventId: matchedEvent },
        {
          $set: {
            matchedPaymentId: matchedFixture.paymentId,
          },
        },
      );
      await models.Payment.updateOne(
        { paymentId: matchedFixture.paymentId, version: 0 },
        {
          $set: {
            matchedEventId: matchedEvent,
            transactionHash: txOf(31),
            amountReceived: "900",
            matchedAt: new Date(),
          },
          $inc: { version: 1 },
        },
      );
      await models.OnChainEvent.updateOne(
        { eventId: confirmedEvent },
        { $set: { matchedPaymentId: confirmedFixture.paymentId } },
      );
      await models.Payment.updateOne(
        { paymentId: confirmedFixture.paymentId, version: 0 },
        {
          $set: {
            matchedEventId: confirmedEvent,
            transactionHash: txOf(32),
            amountReceived: "900",
            confirmations: 2,
            confirmedAt: new Date(),
            terminalAt: new Date(),
          },
          $inc: { version: 1 },
        },
      );

      // Live chain forked at block 3: heights 4 and 5 carry different hashes.
      const live = [
        header(0),
        header(1),
        header(2),
        header(3),
        header(4, 7),
        header(5, 7),
      ];
      const { observation, corroborator } = fakeObservation(live);
      const resolver = new ReorgResolutionService(
        connection,
        testConfig().processing,
        logger,
      );

      const outcome = await resolver.resolve({
        chainId: reorgChain,
        observation,
        corroborator,
        cursorStorage: storage(),
      });
      expect(outcome).toBe("resolved");

      const cursor = await storage().read();
      expect(cursor?.lastProcessedBlock).toBe(3);
      expect(cursor?.lastProcessedBlockHash).toBe(hashOf(3));

      await expect(
        models.ObservedBlock.countDocuments({
          chain: reorgChain,
          blockNumber: { $gt: 3 },
          canonical: true,
        }),
      ).resolves.toBe(0);
      await expect(
        models.ObservedBlock.countDocuments({
          chain: reorgChain,
          blockNumber: { $gt: 3 },
          canonical: false,
        }),
      ).resolves.toBe(2);

      const record = (await models.ReorgRecord.findOne({
        chain: reorgChain,
      }).lean()) as {
        readonly reorgId: string;
        readonly fromBlock: number;
        readonly toBlock: number;
        readonly orphanedTxHashes: readonly string[];
        readonly affectedPaymentIds: readonly string[];
      } | null;
      expect(record?.fromBlock).toBe(4);
      expect(record?.toBlock).toBe(5);
      const affected = record?.affectedPaymentIds ?? [];
      for (const id of [
        pendingFixture.paymentId,
        matchedFixture.paymentId,
        confirmedFixture.paymentId,
      ]) {
        expect(affected).toContain(id);
      }
      for (const hash of [txOf(30), txOf(31), txOf(32)]) {
        expect(record?.orphanedTxHashes ?? []).toContain(hash);
      }

      // Events stay persisted and claimed, but non-canonical.
      for (const eventId of [partialEvent, matchedEvent, confirmedEvent]) {
        const doc = (await models.OnChainEvent.findOne({
          eventId,
        }).lean()) as unknown as Record<string, unknown>;
        expect(doc["canonical"]).toBe(false);
        expect(doc["matchedPaymentId"]).toBeDefined();
      }

      // Pending partial recomputed from surviving canonical claims.
      const pending = await paymentDoc(pendingFixture.paymentId);
      expect(pending["partialAmountReceived"]).toBe("0");
      expect(pending["status"]).toBe("pending");

      // Deep-reorg finality incident on the confirmed payment.
      const confirmed = await paymentDoc(confirmedFixture.paymentId);
      expect(confirmed["status"]).toBe("confirmed");
      expect(confirmed["automationHold"]).toBe(true);
      expect(confirmed["automationHoldReorgId"]).toBe(record?.reorgId);
      await expect(
        models.AuditLog.countDocuments({
          entityId: confirmedFixture.paymentId,
          action: "payment_finality_incident",
        }),
      ).resolves.toBe(1);
      await expect(
        models.ReconciliationAnnotation.countDocuments({
          entityId: confirmedFixture.paymentId,
          category: "reorg",
          status: "open",
        }),
      ).resolves.toBe(1);

      // Non-terminal matched payment annotated for replacement monitoring.
      await expect(
        models.ReconciliationAnnotation.countDocuments({
          entityId: matchedFixture.paymentId,
          category: "reorg",
          status: "open",
        }),
      ).resolves.toBe(1);
    });

    it("re-links a matched payment when a canonical replacement arrives", async () => {
      const { paymentId, recipient } = await createPaymentFixture({
        seed: "replacement",
        amount: "900",
        status: "matched",
        matchedEventId: `event_${namespace}_40`,
        transactionHash: txOf(40),
      });
      await models.Payment.updateOne(
        { paymentId, version: 0 },
        {
          $set: { amountReceived: "900", matchedAt: new Date() },
          $inc: { version: 1 },
        },
      );
      await createEventFixture({
        seed: 40,
        toAddress: recipient,
        amount: "900",
        canonical: false,
      });
      await models.OnChainEvent.updateOne(
        { eventId: `event_${namespace}_40` },
        { $set: { matchedPaymentId: paymentId } },
      );

      const replacement = await createEventFixture({
        seed: 41,
        toAddress: recipient,
        amount: "900",
        blockNumber: 110,
      });
      const { enqueued, enqueuer } = recordingEnqueuer();
      const service = new PaymentMatchingService(connection, testConfig(), {
        confirmations: enqueuer,
      });
      await expect(service.matchEvent(replacement, logger)).resolves.toMatchObject({
        action: "replacement_linked",
        paymentId,
      });
      const doc = await paymentDoc(paymentId);
      expect(doc["matchedEventId"]).toBe(replacement);
      expect(doc["transactionHash"]).toBe(txOf(41));
      expect(doc["confirmations"]).toBe(0);
      expect(enqueued).toEqual([paymentId]);
    });

    it("halts unresolvable when corroboration disagrees", async () => {
      await seedBlocks(2);
      const live = [header(0), header(1), header(2, 9)];
      const { observation, corroborator, setCorroboration } = fakeObservation(live);
      setCorroboration("disagreement");
      const resolver = new ReorgResolutionService(
        connection,
        testConfig().processing,
        logger,
      );
      const outcome = await resolver.resolve({
        chainId: reorgChain,
        observation,
        corroborator,
        cursorStorage: storage(),
      });
      expect(outcome).toBe("unresolvable");
      const cursor = await storage().read();
      expect(cursor?.lastProcessedBlock).toBe(2);
    });
  });
});
