import { createHash, randomBytes, randomUUID } from "node:crypto";

import mongoose, { type Connection } from "mongoose";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ComplianceService,
  sanctionsListContentHash,
} from "../../src/application/compliance/compliance-service.js";
import { hashSecret } from "../../src/infrastructure/auth/secret-hasher.js";
import { ScreeningService } from "../../src/application/compliance/screening-service.js";
import type { AdminPrincipal } from "../../src/application/auth/principals.js";
import {
  PaymentConfirmationService,
  type ConfirmationObservation,
  type PaymentConfirmationReader,
} from "../../src/application/processing/payment-confirmation-service.js";
import { UpdateableSanctionsListProvider } from "../../src/infrastructure/compliance/updateable-list-provider.js";
import { registerPersistenceModels } from "../../src/infrastructure/mongodb/models.js";
import { runDatabaseMigrations } from "../../src/infrastructure/mongodb/migrations/runner.js";
import { loadConfig, type RuntimeConfig } from "../../src/config/environment.js";
import { validEnvironment } from "../helpers/environment.js";

const integrationUri = process.env["MONGODB_INTEGRATION_URI"];
const apiBaseUrl = process.env["PHASE03_API_URL"];
const describeWithMongo = integrationUri === undefined ? describe.skip : describe;
const describeWithApi =
  integrationUri !== undefined && apiBaseUrl !== undefined ? describe : describe.skip;

const logger = pino({ level: "silent" });
const namespace = randomBytes(6).toString("hex");

const chainId = "ethereum-sepolia";
const sanctionedSender = `0x${randomBytes(20).toString("hex")}`;
const cleanSender = `0x${randomBytes(20).toString("hex")}`;

function testConfig(
  overrides: Partial<RuntimeConfig["compliance"]> = {},
): RuntimeConfig {
  const base = loadConfig(validEnvironment());
  return {
    ...base,
    compliance: { ...base.compliance, screeningCacheTtlSec: 600, ...overrides },
  };
}

function adminPrincipal(): AdminPrincipal {
  return {
    kind: "admin",
    adminId: `admin_${namespace}`,
    sessionId: `session_${namespace}`,
    tokenVersion: 0,
  };
}

describeWithMongo("Phase 08 compliance controls", () => {
  let connection!: Connection;
  let models!: ReturnType<typeof registerPersistenceModels>;
  let compliance: ComplianceService;
  let provider: UpdateableSanctionsListProvider;
  let screening: ScreeningService;
  let apiToken = "";

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
    await expect(runDatabaseMigrations(connection)).resolves.toBe(5);
    // Hermetic suite: prior runs (and the live router tests) leave active
    // lists and unexpired screening cache records that must not leak in.
    await models.SanctionsList.collection.deleteMany({});
    await models.SanctionsAddress.collection.deleteMany({});
    await models.ComplianceScreening.collection.deleteMany({});
    await models.ComplianceReview.collection.deleteMany({});
    const config = testConfig();
    provider = new UpdateableSanctionsListProvider(
      connection,
      config.compliance,
      logger,
    );
    screening = new ScreeningService(connection, config.compliance, provider, logger);
    compliance = new ComplianceService(connection, logger, provider);

    if (apiBaseUrl !== undefined) {
      await models.AdminIdentity.create({
        adminId: `admin_${namespace}`,
        email: `phase08-${namespace}@example.com`,
        passwordHash: await hashSecret("phase08-admin-password-that-is-long-enough"),
        role: "admin",
        status: "active",
        tokenVersion: 0,
      });
      const login = await fetch(`${apiBaseUrl}/api/v1/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `phase08-${namespace}@example.com`,
          password: "phase08-admin-password-that-is-long-enough",
        }),
      });
      expect(login.status).toBe(200);
      apiToken = ((await login.json()) as { accessToken: string }).accessToken;
    }
  });

  afterAll(async () => {
    await connection.close();
  });

  async function ingestList(
    addresses: string[],
    listVersion = `v-${randomUUID().slice(0, 8)}`,
  ) {
    return compliance.ingestSanctionsList(adminPrincipal(), {
      listVersion,
      source: "ofac-sdn-test",
      addresses,
      contentSha256: sanctionsListContentHash(addresses.map((a) => a.toLowerCase())),
    });
  }

  describe("sanctions list ingestion", () => {
    it("computes an order-insensitive deterministic content hash", () => {
      // The helper operates on normalized addresses (ADR 0013); order and
      // duplicates must not change the digest.
      const left = sanctionsListContentHash([
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ]);
      const right = sanctionsListContentHash([
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ]);
      expect(left).toBe(right);
      expect(left).toMatch(/^[0-9a-f]{64}$/);
    });

    it("activates a managed list with provenance, entries, and audit", async () => {
      const result = await ingestList([sanctionedSender]);
      expect(result.entryCount).toBe(1);
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.replacedVersion).toBeUndefined();

      const active = await models.SanctionsList.findOne({ status: "active" }).lean();
      expect(active).toMatchObject({
        listId: result.listId,
        listVersion: result.listVersion,
        source: "ofac-sdn-test",
        entryCount: 1,
      });
      await expect(
        models.SanctionsAddress.countDocuments({ listId: result.listId }),
      ).resolves.toBe(1);
      await expect(
        models.AuditLog.countDocuments({
          entityType: "SanctionsList",
          entityId: result.listId,
          action: "sanctions_list_updated",
        }),
      ).resolves.toBe(1);
    });

    it("replaces the active list atomically and keeps history", async () => {
      const first = await ingestList([sanctionedSender]);
      const second = await ingestList([cleanSender]);
      expect(second.replacedVersion).toBe(first.listVersion);

      await expect(
        models.SanctionsList.countDocuments({ status: "active" }),
      ).resolves.toBe(1);
      const retired = await models.SanctionsList.findOne({
        listId: first.listId,
      }).lean();
      expect(retired?.status).toBe("retired");
      expect(retired?.retiredAt).toBeDefined();

      // The provider immediately serves the replacement list.
      provider.invalidate();
      await expect(
        screening.screen({ address: cleanSender, chain: chainId }),
      ).resolves.toMatchObject({ verdict: "blocked", listVersion: second.listVersion });
      await expect(
        screening.screen({ address: sanctionedSender, chain: chainId }),
      ).resolves.toMatchObject({ verdict: "clear" });
    });

    it("rejects a mismatched integrity hash without changing the active list", async () => {
      const activeBefore = await models.SanctionsList.findOne({
        status: "active",
      }).lean();
      await expect(
        compliance.ingestSanctionsList(adminPrincipal(), {
          listVersion: "tampered-v1",
          source: "ofac-sdn-test",
          addresses: [sanctionedSender],
          contentSha256: createHash("sha256").update("wrong").digest("hex"),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      const activeAfter = await models.SanctionsList.findOne({
        status: "active",
      }).lean();
      expect(activeAfter?.listId).toBe(activeBefore?.listId);
    });

    it("retires the active list and restores the static fallback (ADR 0017)", async () => {
      await ingestList([sanctionedSender], `retire-${randomUUID().slice(0, 8)}`);
      const result = await compliance.retireActiveSanctionsList(adminPrincipal());
      expect(result.retired).toBe(true);
      expect(result.listVersion).toMatch(/^retire-/);
      await expect(
        models.SanctionsList.countDocuments({ status: "active" }),
      ).resolves.toBe(0);
      await expect(provider.activeListVersion()).resolves.toBe("test-v1");
      await expect(
        screening.screen({ address: cleanSender, chain: chainId }),
      ).resolves.toMatchObject({
        provider: "static-list",
        listVersion: "test-v1",
      });
    });

    it("rejects malformed addresses and empty lists", async () => {
      await expect(
        compliance.ingestSanctionsList(adminPrincipal(), {
          listVersion: "bad-v1",
          source: "ofac-sdn-test",
          addresses: ["0x12"],
          contentSha256: sanctionsListContentHash(["0x12"]),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        compliance.ingestSanctionsList(adminPrincipal(), {
          listVersion: "bad-v2",
          source: "ofac-sdn-test",
          addresses: [],
          contentSha256: sanctionsListContentHash([]),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });
  });

  describe("screening fail-closed behavior", () => {
    it("fails closed when the managed list is stale", async () => {
      await ingestList([sanctionedSender]);
      // Simulate staleness directly at the driver level; `ingestedAt` is
      // immutable at the mongoose layer by design.
      await models.SanctionsList.collection.updateOne(
        { status: "active" },
        { $set: { ingestedAt: new Date(Date.now() - 400 * 24 * 3600 * 1000) } },
      );
      provider.invalidate();
      await expect(
        screening.screen({ address: cleanSender, chain: chainId }),
      ).resolves.toMatchObject({ verdict: "unavailable" });
    });

    it("keeps raw provider payloads out of default projections", async () => {
      await ingestList([sanctionedSender]);
      provider.invalidate();
      await screening.screen({ address: cleanSender, chain: chainId });
      const record = await models.ComplianceScreening.findOne({
        normalizedAddress: cleanSender,
      }).lean();
      expect(record).not.toBeNull();
      expect(record).not.toHaveProperty("rawResponse");
    });

    it("reuses an unexpired verdict and re-screens after a list change", async () => {
      const address = `0x${randomBytes(20).toString("hex")}`;
      await expect(
        screening.screen({ address, chain: chainId }),
      ).resolves.toMatchObject({ verdict: "clear" });
      await expect(
        screening.screen({ address, chain: chainId }),
      ).resolves.toMatchObject({ verdict: "clear", rawResponse: { cache: "hit" } });
      await expect(
        models.ComplianceScreening.countDocuments({ normalizedAddress: address }),
      ).resolves.toBe(1);

      // A new list version that sanctions the address forces a fresh call.
      await ingestList([address]);
      await expect(
        screening.screen({ address, chain: chainId }),
      ).resolves.toMatchObject({ verdict: "blocked" });
      await expect(
        models.ComplianceScreening.countDocuments({ normalizedAddress: address }),
      ).resolves.toBe(2);
    });
  });

  describe("holds queue and review decisions", () => {
    beforeAll(async () => {
      // Self-contained state: an active list that sanctions the sender the
      // hold tests use, independent of the earlier describes.
      await ingestList([sanctionedSender]);
    });

    function scriptedReader(
      observation: ConfirmationObservation,
    ): PaymentConfirmationReader {
      return { observe: () => Promise.resolve(observation) };
    }

    async function confirmingPaymentWithSender(sender: string): Promise<string> {
      const paymentId = `pay_${namespace}_${randomUUID().slice(0, 8)}`;
      const walletAddressId = `wallet_${namespace}_${randomUUID().slice(0, 8)}`;
      const recipient = `0x${randomBytes(20).toString("hex")}`;
      await models.WalletAddress.create({
        walletAddressId,
        merchantId: `merchant_${namespace}`,
        chain: chainId,
        address: recipient,
        normalizedAddress: recipient,
        xpubId: `xpub_${namespace}_${randomUUID().slice(0, 8)}`,
        derivationIndex: Math.floor(Math.random() * 1_000_000),
        status: "assigned",
        assignedPaymentId: paymentId,
      });
      const eventId = `event_${namespace}_${randomUUID().slice(0, 8)}`;
      await models.Payment.create({
        paymentId,
        merchantId: `merchant_${namespace}`,
        chain: chainId,
        token: "token-usdc-sepolia",
        walletAddressId,
        amount: "900",
        status: "matched",
        version: 0,
        requiredConfirmations: 1,
        tokenVerificationPolicy: "event_only",
        confirmations: 0,
        screeningStatus: "pending",
        matchedEventId: eventId,
        transactionHash: `0x${randomBytes(32).toString("hex")}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await models.OnChainEvent.create({
        eventId,
        chain: chainId,
        token: "token-usdc-sepolia",
        contractAddress: `0x${randomBytes(20).toString("hex")}`,
        normalizedContractAddress: `0x${randomBytes(20).toString("hex")}`,
        transactionHash: `0x${randomBytes(32).toString("hex")}`,
        logIndex: 0,
        blockNumber: 100,
        blockHash: `0x${randomBytes(32).toString("hex")}`,
        fromAddress: sender,
        normalizedFromAddress: sender,
        toAddress: recipient,
        normalizedToAddress: recipient,
        amount: "900",
        rawEvent: {},
        canonical: true,
        interpretationStatus: "accepted",
        matchedPaymentId: paymentId,
        ingestedAt: new Date(),
      });
      return paymentId;
    }

    function confirmationService(): PaymentConfirmationService {
      return new PaymentConfirmationService(connection, testConfig(), {
        reader: scriptedReader({
          status: "observed",
          canonical: true,
          confirmations: 10,
        }),
        screening,
        latestReviewDecision: (paymentId) => compliance.latestDecision(paymentId),
      });
    }

    it("holds a sanctioned sender and cannot confirm without a release", async () => {
      const paymentId = await confirmingPaymentWithSender(sanctionedSender);
      const sut = confirmationService();
      await expect(sut.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "progressed",
        status: "confirming",
      });
      await expect(sut.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "held",
      });
      const doc = await models.Payment.findOne({ paymentId }).lean();
      expect(doc?.status).toBe("confirming");
      expect(doc?.screeningStatus).toBe("blocked");

      // Retries keep holding; no path confirms.
      await expect(sut.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "held",
      });

      const holds = await compliance.listHolds(50);
      const hold = holds.find((entry) => entry.paymentId === paymentId);
      expect(hold).toMatchObject({ screeningStatus: "blocked", status: "confirming" });

      // An authorized release decision unblocks the gate with audit.
      const decision = await compliance.recordReviewDecision(adminPrincipal(), {
        paymentId,
        decision: "release",
        reason: "Cleared after manual sanctions review with documented evidence",
        evidence: "case-42",
      });
      expect(decision.decision).toBe("release");
      await expect(sut.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "terminal",
        status: "confirmed",
      });
      await expect(
        models.AuditLog.countDocuments({
          entityId: paymentId,
          action: "payment_compliance_override_released",
        }),
      ).resolves.toBe(1);
      await expect(
        models.AuditLog.countDocuments({
          entityId: paymentId,
          action: "compliance_review_decision",
        }),
      ).resolves.toBe(1);
      const review = await models.ComplianceReview.findOne({ paymentId }).lean();
      expect(review).toMatchObject({
        decision: "release",
        reviewedBy: `admin_${namespace}`,
      });
    });

    it("pins a block decision so the payment can never confirm", async () => {
      const paymentId = await confirmingPaymentWithSender(cleanSender);
      await compliance.recordReviewDecision(adminPrincipal(), {
        paymentId,
        decision: "block",
        reason: "Manual review confirmed sanctioned exposure",
      });
      const sut = confirmationService();
      await expect(sut.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "progressed",
        status: "confirming",
      });
      await expect(sut.advancePayment(paymentId, logger)).resolves.toMatchObject({
        outcome: "held",
      });
      const doc = await models.Payment.findOne({ paymentId }).lean();
      expect(doc?.screeningStatus).toBe("blocked");
      expect(doc?.status).toBe("confirming");
    });

    it("rejects decisions for unknown payments", async () => {
      await expect(
        compliance.recordReviewDecision(adminPrincipal(), {
          paymentId: `pay_${namespace}_missing`,
          decision: "release",
          reason: "Should not exist anywhere",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describeWithApi("compliance router", () => {
    it("rejects unauthenticated sanctions-list ingestion", async () => {
      const response = await fetch(
        `${apiBaseUrl}/api/v1/admin/compliance/sanctions-list`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            listVersion: "v1",
            source: "s",
            addresses: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            contentSha256: "0".repeat(64),
          }),
        },
      );
      expect(response.status).toBe(401);
    });

    it("rejects a malformed decision body with a validation envelope", async () => {
      const response = await fetch(
        `${apiBaseUrl}/api/v1/admin/compliance/holds/pay_whatever/decision`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify({ decision: "release", reason: "short" }),
        },
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("VALIDATION_ERROR");
    });

    it("ingests a sanctions list through the audited admin endpoint", async () => {
      const addresses = [`0x${randomBytes(20).toString("hex")}`];
      const response = await fetch(
        `${apiBaseUrl}/api/v1/admin/compliance/sanctions-list`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify({
            listVersion: `live-${namespace}`,
            source: "ofac-sdn-test",
            addresses,
            contentSha256: sanctionsListContentHash(addresses),
          }),
        },
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { listId: string; entryCount: number };
      expect(body.entryCount).toBe(1);
      await expect(
        models.AuditLog.countDocuments({ entityId: body.listId }),
      ).resolves.toBeGreaterThanOrEqual(1);
    });

    it("resets to the static fallback through the development-gated retire control", async () => {
      const response = await fetch(
        `${apiBaseUrl}/api/v1/admin/compliance/sanctions-list/active`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${apiToken}` },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        retired: boolean;
        listVersion?: string;
      };
      expect(body.retired).toBe(true);
      expect(body.listVersion).toMatch(/^live-/);
      await expect(
        models.SanctionsList.countDocuments({ status: "active" }),
      ).resolves.toBe(0);
    });
  });
});
