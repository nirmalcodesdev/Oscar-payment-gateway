import mongoose, { type Connection } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendAuditEntry,
  appendAuditEntryInTransaction,
  verifyAuditChain,
} from "../../src/infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../src/infrastructure/mongodb/models.js";
import {
  assertDatabaseCompatibility,
  DatabaseCompatibilityError,
  runDatabaseMigrations,
} from "../../src/infrastructure/mongodb/migrations/runner.js";
import { databaseMigrations } from "../../src/infrastructure/mongodb/migrations/catalog.js";
import {
  assertTransactionCapability,
  withRequiredTransaction,
} from "../../src/infrastructure/mongodb/transactions.js";

const integrationUri = process.env["MONGODB_INTEGRATION_URI"];
const describeWithMongo = integrationUri === undefined ? describe.skip : describe;

const addressA = "0x1111111111111111111111111111111111111111";
const addressB = "0x2222222222222222222222222222222222222222";
const addressC = "0x3333333333333333333333333333333333333333";
const addressD = "0x4444444444444444444444444444444444444444";
const contractAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const transactionA = `0x${"1".repeat(64)}`;
const transactionB = `0x${"2".repeat(64)}`;
const blockHash = `0x${"a".repeat(64)}`;

function eventFixture(
  eventId: string,
  transactionHash: string,
  matchedPaymentId?: string,
) {
  return {
    eventId,
    chain: "ethereum-mainnet",
    token: "usdc-mainnet",
    contractAddress,
    normalizedContractAddress: contractAddress,
    transactionHash,
    logIndex: 0,
    blockNumber: 123,
    blockHash,
    fromAddress: addressA,
    normalizedFromAddress: addressA,
    toAddress: addressB,
    normalizedToAddress: addressB,
    amount: "1000000",
    rawEvent: { topics: ["transfer"], data: "0x01" },
    canonical: true,
    ingestedAt: new Date(),
    ...(matchedPaymentId === undefined ? {} : { matchedPaymentId }),
  };
}

async function fulfilledCount(promises: readonly Promise<unknown>[]): Promise<number> {
  const results = await Promise.allSettled(promises);
  return results.filter((result) => result.status === "fulfilled").length;
}

function requireDatabase(connection: Connection) {
  if (connection.db === undefined) throw new Error("MongoDB connection is not ready");
  return connection.db;
}

describeWithMongo("Phase 02 persistence invariants", () => {
  let connection: Connection;
  let models: ReturnType<typeof registerPersistenceModels>;

  beforeAll(async () => {
    if (integrationUri === undefined) {
      throw new Error("MONGODB_INTEGRATION_URI is required for integration tests");
    }
    connection = mongoose.createConnection(integrationUri, {
      serverSelectionTimeoutMS: 10_000,
      autoIndex: false,
      bufferCommands: false,
    });
    await connection.asPromise();
    models = registerPersistenceModels(connection);
    await requireDatabase(connection).collection("migration_leases").deleteMany({});
    await runDatabaseMigrations(connection);

    for (const schema of Object.values(models)) {
      await schema.collection.deleteMany({});
    }
  });

  afterAll(async () => {
    await connection.close();
  });

  it("installs the migration exactly once and accepts the supported database version", async () => {
    await expect(runDatabaseMigrations(connection)).resolves.toBe(2);
    await expect(assertDatabaseCompatibility(connection)).resolves.toBeUndefined();
    const metadata = await requireDatabase(connection)
      .collection<{
        _id: string;
        version: number;
        migrations: unknown[];
      }>("schema_metadata")
      .findOne({ _id: "current" });
    expect(metadata?.version).toBe(2);
    expect(metadata?.migrations).toHaveLength(2);
  });

  it("refuses an incompatible database schema version", async () => {
    const metadata = requireDatabase(connection).collection<{
      _id: string;
      version: number;
    }>("schema_metadata");
    await metadata.updateOne({ _id: "current" }, { $set: { version: 99 } });
    await expect(assertDatabaseCompatibility(connection)).rejects.toBeInstanceOf(
      DatabaseCompatibilityError,
    );
    await metadata.updateOne({ _id: "current" }, { $set: { version: 2 } });
  });

  it("refuses a concurrent migration lease", async () => {
    const leases = requireDatabase(connection).collection<{
      _id: string;
      owner: string;
      expiresAt: Date;
    }>("migration_leases");
    await leases.deleteMany({});
    await leases.insertOne({
      _id: "database-schema",
      owner: "another-deployment",
      expiresAt: new Date(Date.now() + 60_000),
    });
    try {
      await expect(runDatabaseMigrations(connection)).rejects.toThrow();
    } finally {
      await leases.deleteMany({});
    }
  });

  it("refuses a changed checksum for an applied migration", async () => {
    const metadata = requireDatabase(connection).collection<{
      _id: string;
      migrations: { checksum: string }[];
    }>("schema_metadata");
    await metadata.updateOne(
      { _id: "current" },
      { $set: { "migrations.0.checksum": "f".repeat(64) } },
    );
    try {
      await expect(runDatabaseMigrations(connection)).rejects.toBeInstanceOf(
        DatabaseCompatibilityError,
      );
    } finally {
      await metadata.updateOne(
        { _id: "current" },
        { $set: { "migrations.0.checksum": databaseMigrations[0].checksum } },
      );
    }
  });

  it("proves the deployment supports correctness-critical transactions", async () => {
    await expect(assertTransactionCapability(connection)).resolves.toBeUndefined();
  });

  it("atomically rejects duplicate raw event identities under concurrency", async () => {
    await models.OnChainEvent.collection.deleteMany({});
    expect(
      await fulfilledCount([
        models.OnChainEvent.create(eventFixture("event_duplicate", transactionA)),
        models.OnChainEvent.create(eventFixture("event_duplicate", transactionA)),
      ]),
    ).toBe(1);
    await expect(models.OnChainEvent.countDocuments()).resolves.toBe(1);
  });

  it("allows one on-chain event to claim a payment globally", async () => {
    await models.OnChainEvent.collection.deleteMany({});
    expect(
      await fulfilledCount([
        models.OnChainEvent.create(
          eventFixture("event_claim_a", transactionA, "payment_claimed"),
        ),
        models.OnChainEvent.create(
          eventFixture("event_claim_b", transactionB, "payment_claimed"),
        ),
      ]),
    ).toBe(1);
    await expect(
      models.OnChainEvent.countDocuments({ matchedPaymentId: "payment_claimed" }),
    ).resolves.toBe(1);
  });

  it("atomically rejects duplicate derivation indexes and payment assignments", async () => {
    await models.WalletAddress.collection.deleteMany({});
    const wallet = (
      walletAddressId: string,
      address: string,
      assignedPaymentId: string,
    ) => ({
      walletAddressId,
      merchantId: "merchant_001",
      chain: "ethereum-mainnet",
      address,
      normalizedAddress: address,
      xpubId: "xpub_001",
      derivationIndex: 7,
      assignedPaymentId,
      status: "assigned",
      assignedAt: new Date(),
    });

    expect(
      await fulfilledCount([
        models.WalletAddress.create(wallet("wallet_a", addressA, "payment_a")),
        models.WalletAddress.create(wallet("wallet_b", addressB, "payment_b")),
      ]),
    ).toBe(1);

    await models.WalletAddress.collection.deleteMany({});
    expect(
      await fulfilledCount([
        models.WalletAddress.create(wallet("wallet_c", addressB, "payment_shared")),
        models.WalletAddress.create({
          ...wallet("wallet_d", addressC, "payment_shared"),
          derivationIndex: 8,
        }),
      ]),
    ).toBe(1);
  });

  it("atomically prevents one wallet address from backing two payments", async () => {
    await models.Payment.collection.deleteMany({
      paymentId: { $in: ["payment_wallet_a", "payment_wallet_b"] },
    });
    const payment = (paymentId: string) => ({
      paymentId,
      merchantId: "merchant_001",
      chain: "ethereum-mainnet",
      token: "usdc-mainnet",
      walletAddressId: "wallet_payment_unique",
      amount: "1000000",
      status: "pending",
      version: 0,
      requiredConfirmations: 12,
      confirmations: 0,
      screeningStatus: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(
      await fulfilledCount([
        models.Payment.create(payment("payment_wallet_a")),
        models.Payment.create(payment("payment_wallet_b")),
      ]),
    ).toBe(1);
  });

  it("atomically scopes idempotency keys", async () => {
    await models.IdempotencyKey.collection.deleteMany({});
    const record = {
      key: "checkout-request-001",
      scope: "merchant_001:create-payment",
      requestFingerprint: "a".repeat(64),
      response: { paymentId: "payment_001" },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(
      await fulfilledCount([
        models.IdempotencyKey.create(record),
        models.IdempotencyKey.create(record),
      ]),
    ).toBe(1);
  });

  it("rejects invalid direct database money writes through collection validation", async () => {
    await expect(
      models.Payment.collection.insertOne({
        paymentId: "payment_invalid_amount",
        merchantId: "merchant_001",
        chain: "ethereum-mainnet",
        token: "usdc-mainnet",
        walletAddressId: "wallet_invalid",
        amount: "1.5",
        status: "pending",
        version: 0,
        requiredConfirmations: 12,
        screeningStatus: "pending",
        expiresAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("builds an append-only verifiable audit chain and detects tampering", async () => {
    await models.AuditLog.collection.deleteMany({ scope: "merchant_audit" });
    await models.AuditChainHead.collection.deleteMany({ scope: "merchant_audit" });
    const first = await appendAuditEntry(connection, {
      scope: "merchant_audit",
      entityType: "Payment",
      entityId: "payment_audit",
      action: "created",
      actorType: "merchant",
      actorId: "merchant_001",
      after: { status: "pending", amount: "1000000" },
    });
    await appendAuditEntry(connection, {
      scope: "merchant_audit",
      entityType: "Payment",
      entityId: "payment_audit",
      action: "matched",
      actorType: "system",
      actorId: "processor",
      before: { status: "pending" },
      after: { status: "matched" },
      eventId: "event_audit",
      transactionHash: transactionA,
    });

    await expect(verifyAuditChain(connection, "merchant_audit")).resolves.toEqual({
      valid: true,
      entriesChecked: 2,
    });
    await expect(
      models.AuditLog.updateOne(
        { auditId: first.auditId },
        { $set: { action: "tamper" } },
      ),
    ).rejects.toThrow("append-only");
    await expect(models.AuditLog.deleteOne({ auditId: first.auditId })).rejects.toThrow(
      "append-only",
    );

    await models.AuditLog.collection.updateOne(
      { auditId: first.auditId },
      { $set: { action: "tampered-directly" } },
    );
    const verification = await verifyAuditChain(connection, "merchant_audit");
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("hash");

    await models.AuditLog.collection.deleteMany({ scope: "merchant_audit" });
    const missingEntries = await verifyAuditChain(connection, "merchant_audit");
    expect(missingEntries.valid).toBe(false);
    expect(missingEntries.reason).toContain("without retained entries");
  });

  it("serializes concurrent audit writers into one contiguous chain", async () => {
    const scope = "merchant_concurrent_audit";
    await models.AuditLog.collection.deleteMany({ scope });
    await models.AuditChainHead.collection.deleteMany({ scope });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendAuditEntry(connection, {
          scope,
          entityType: "Payment",
          entityId: `payment_concurrent_${index}`,
          action: "created",
          actorType: "system",
          actorId: "concurrency-test",
          metadata: { index },
        }),
      ),
    );
    await expect(verifyAuditChain(connection, scope)).resolves.toEqual({
      valid: true,
      entriesChecked: 8,
    });
  });

  it("rolls back payment, wallet assignment, audit entry, and chain head together", async () => {
    const paymentId = "payment_rollback";
    const scope = "merchant_rollback";
    await models.Payment.collection.deleteMany({ paymentId });
    await models.WalletAddress.collection.deleteMany({ assignedPaymentId: paymentId });
    await models.AuditLog.collection.deleteMany({ scope });
    await models.AuditChainHead.collection.deleteMany({ scope });

    await expect(
      withRequiredTransaction(connection, async (session) => {
        await models.WalletAddress.create(
          [
            {
              walletAddressId: "wallet_rollback",
              merchantId: "merchant_rollback",
              chain: "ethereum-mainnet",
              address: addressD,
              normalizedAddress: addressD,
              xpubId: "xpub_rollback",
              derivationIndex: 99,
              assignedPaymentId: paymentId,
              status: "assigned",
              assignedAt: new Date(),
            },
          ],
          { session },
        );
        await models.Payment.create(
          [
            {
              paymentId,
              merchantId: "merchant_rollback",
              chain: "ethereum-mainnet",
              token: "usdc-mainnet",
              walletAddressId: "wallet_rollback",
              amount: "1000000",
              status: "pending",
              version: 0,
              requiredConfirmations: 12,
              confirmations: 0,
              screeningStatus: "pending",
              expiresAt: new Date(Date.now() + 60_000),
            },
          ],
          { session },
        );
        await appendAuditEntryInTransaction(
          connection,
          {
            scope,
            entityType: "Payment",
            entityId: paymentId,
            action: "created",
            actorType: "merchant",
            actorId: "merchant_rollback",
          },
          session,
        );
        throw new Error("force persistence rollback");
      }),
    ).rejects.toThrow("force persistence rollback");

    await expect(models.Payment.countDocuments({ paymentId })).resolves.toBe(0);
    await expect(
      models.WalletAddress.countDocuments({ assignedPaymentId: paymentId }),
    ).resolves.toBe(0);
    await expect(models.AuditLog.countDocuments({ scope })).resolves.toBe(0);
    await expect(models.AuditChainHead.countDocuments({ scope })).resolves.toBe(0);
  });
});
