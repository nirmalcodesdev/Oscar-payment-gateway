import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import mongoose, { type Connection } from "mongoose";
import pino from "pino";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EventIngestionService,
  deriveEventId,
  type EventEnqueuer,
  type IngestEventInput,
} from "../../src/application/ingestion/event-ingestion-service.js";
import {
  EventInterpretationService,
  type InterpretationOutcome,
} from "../../src/application/ingestion/event-interpretation-service.js";
import { loadConfig, type RuntimeConfig } from "../../src/config/environment.js";
import type {
  BalanceDeltaRead,
  BalanceDeltaReader,
} from "../../src/domain/chain/chain-adapter.js";
import {
  ChainCursorConflictError,
  ChainDiscontinuityError,
  type ObservedBlockHeader,
} from "../../src/domain/chain/chain-adapter.js";
import {
  IngestionHmacVerifier,
  ingestionHeaderNames,
  signIngestionPayload,
} from "../../src/infrastructure/auth/ingestion-hmac.js";
import { MongoChainCursorStorage } from "../../src/infrastructure/chain/mongo-cursor-storage.js";
import { erc20TransferTopic } from "../../src/infrastructure/chain/evm-registry-verifier.js";
import { registerPersistenceModels } from "../../src/infrastructure/mongodb/models.js";
import { runDatabaseMigrations } from "../../src/infrastructure/mongodb/migrations/runner.js";
import {
  EventQueue,
  eventInterpretationQueueName,
} from "../../src/infrastructure/queue/event-queue.js";
import { EventInterpretationWorkerResource } from "../../src/infrastructure/queue/event-worker.js";
import { RedisResource } from "../../src/infrastructure/redis/redis-resource.js";
import { createApp } from "../../src/interfaces/http/create-app.js";
import { createInternalEventsRouter } from "../../src/interfaces/http/internal-events-router.js";
import { validEnvironment } from "../helpers/environment.js";

const integrationUri = process.env["MONGODB_INTEGRATION_URI"];
const describeWithMongo = integrationUri === undefined ? describe.skip : describe;

const config: RuntimeConfig = loadConfig(validEnvironment());
const logger = pino({ level: "silent" });

const chainId = "ethereum-sepolia";
const eventOnlyContract = "0xcccccccccccccccccccccccccccccccccccccc01";
const deltaContract = "0xcccccccccccccccccccccccccccccccccccccc02";
const unregisteredContract = "0xdddddddddddddddddddddddddddddddddddddd01";
const sender = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const stranger = "0x9999999999999999999999999999999999999999";
const namespace = randomBytes(6).toString("hex");

const hashOf = (blockNumber: number): string =>
  `0x${blockNumber.toString(16).padStart(64, "0")}`;
const txOf = (seed: number): string => `0x${seed.toString(16).padStart(64, "0")}`;
const topicAddress = (address: string): string =>
  `0x${"0".repeat(24)}${address.slice(2)}`;
const wordAmount = (amount: bigint): string =>
  `0x${amount.toString(16).padStart(64, "0")}`;

/** Verbatim ERC-20 Transfer log matching the normalized fields exactly. */
function transferRaw(
  from: string,
  to: string,
  amount: bigint,
): Record<string, unknown> {
  return {
    topics: [erc20TransferTopic, topicAddress(from), topicAddress(to)],
    data: wordAmount(amount),
  };
}

function blockHeader(blockNumber: number): ObservedBlockHeader {
  return {
    blockNumber,
    blockHash: hashOf(blockNumber),
    parentHash: blockNumber === 0 ? `0x${"0".repeat(64)}` : hashOf(blockNumber - 1),
  };
}

function eventInput(overrides: Partial<IngestEventInput> = {}): IngestEventInput {
  return {
    chain: chainId,
    transactionHash: txOf(1),
    logIndex: 0,
    blockNumber: 100,
    blockHash: `0x${"b".repeat(64)}`,
    contractAddress: eventOnlyContract,
    fromAddress: sender,
    toAddress: recipient,
    amount: "900",
    rawEvent: transferRaw(sender, recipient, 900n),
    ...overrides,
  };
}

function deltaKey(input: {
  readonly chain: string;
  readonly contractAddress?: string;
  readonly holder: string;
  readonly blockNumber: number;
}): string {
  return `${input.chain}:${input.contractAddress ?? ""}:${input.holder}:${input.blockNumber}`;
}

function scriptableDeltaReader(
  responses: ReadonlyMap<string, BalanceDeltaRead>,
): BalanceDeltaReader & {
  readonly calls: Parameters<BalanceDeltaReader["readDelta"]>[0][];
} {
  const calls: Parameters<BalanceDeltaReader["readDelta"]>[0][] = [];
  return {
    calls,
    readDelta: (input) => {
      calls.push(input);
      return Promise.resolve(
        responses.get(deltaKey(input)) ?? { status: "unavailable" },
      );
    },
  };
}

function issuePaths(body: unknown): string[] {
  const error = (body as { error?: { details?: { issues?: { path?: unknown }[] } } })
    .error;
  return (error?.details?.issues ?? []).flatMap((issue) =>
    typeof issue.path === "string" ? [issue.path] : [],
  );
}

function requireDatabase(connection: Connection) {
  if (connection.db === undefined) throw new Error("MongoDB connection is not ready");
  return connection.db;
}

describeWithMongo("Phase 06 event ingestion and interpretation", () => {
  let connection!: Connection;
  let models!: ReturnType<typeof registerPersistenceModels>;
  let baseUrl = "";
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  const enqueued: string[] = [];
  const queue: EventEnqueuer = {
    enqueueInterpretation: (eventId) => {
      enqueued.push(eventId);
      return Promise.resolve();
    },
  };

  function signed(
    body: object,
    overrides: {
      readonly keyId?: string;
      readonly timestamp?: string;
      readonly nonce?: string;
      readonly secret?: string;
      readonly signature?: string;
    } = {},
  ): { readonly raw: Buffer; readonly headers: Record<string, string> } {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
    const nonce = overrides.nonce ?? randomBytes(32).toString("base64url");
    const keyId = overrides.keyId ?? config.ingestion.hmacCurrentKeyId;
    const secret = overrides.secret ?? config.ingestion.hmacCurrentSecret;
    const signature =
      overrides.signature ?? signIngestionPayload(secret, timestamp, nonce, raw);
    return {
      raw,
      headers: {
        "content-type": "application/json",
        [ingestionHeaderNames.keyId]: keyId,
        [ingestionHeaderNames.timestamp]: timestamp,
        [ingestionHeaderNames.nonce]: nonce,
        [ingestionHeaderNames.signature]: signature,
      },
    };
  }

  async function postEvent(
    payload: Buffer | string,
    headers: Record<string, string>,
  ): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}/api/v1/internal/on-chain-events`, {
      method: "POST",
      headers,
      // Buffer is not part of the DOM `BodyInit` union; its bytes go over the
      // wire unchanged as a Uint8Array.
      body: typeof payload === "string" ? payload : new Uint8Array(payload),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

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

    await requireDatabase(connection).collection("migration_leases").deleteMany({});
    await expect(runDatabaseMigrations(connection)).resolves.toBe(6);
    for (const model of Object.values(models)) {
      await model.collection.deleteMany({});
    }

    await models.Chain.create({
      chainId,
      networkFamily: "evm",
      networkChainId: 11155111,
      name: "Ethereum Sepolia",
      rpcProviders: [
        { providerId: "local-rpc-a", operatorId: "local-operator-a" },
        { providerId: "local-rpc-b", operatorId: "local-operator-b" },
      ],
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      requiredConfirmations: 2,
      enabled: true,
      version: 0,
      allocationSequence: 0,
      verifiedAt: new Date(),
    });
    await models.Token.create([
      {
        tokenId: "token-usdc-sepolia",
        chain: chainId,
        symbol: "USDC",
        contractAddress: eventOnlyContract,
        normalizedContractAddress: eventOnlyContract,
        decimals: 6,
        minAmount: "1",
        maxAmount: "1000000000000",
        verificationPolicy: "event_only",
        enabled: true,
        verificationStatus: "verified",
        version: 1,
        verifiedAt: new Date(),
      },
      {
        tokenId: "token-risk-sepolia",
        chain: chainId,
        symbol: "RISK",
        contractAddress: deltaContract,
        normalizedContractAddress: deltaContract,
        decimals: 6,
        minAmount: "1",
        maxAmount: "1000000000000",
        verificationPolicy: "balance_delta_required",
        enabled: true,
        verificationStatus: "verified",
        version: 1,
        verifiedAt: new Date(),
      },
    ]);
    await models.WalletAddress.create({
      walletAddressId: `wallet_phase06_${namespace}`,
      merchantId: `merchant_phase06_${namespace}`,
      chain: chainId,
      address: recipient,
      normalizedAddress: recipient,
      xpubId: `xpub_phase06_${namespace}`,
      derivationIndex: 0,
      status: "available",
    });

    const app = createApp(
      logger,
      { isReady: () => Promise.resolve(true) },
      {
        apiRouters: [createInternalEventsRouter({ connection, config, queue })],
      },
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await connection.close();
  });

  describe("schema migration 0003", () => {
    it("is idempotent and settles the database at version 5", async () => {
      await expect(runDatabaseMigrations(connection)).resolves.toBe(6);
      const metadata = await requireDatabase(connection)
        .collection<{ _id: string; version: number }>("schema_metadata")
        .findOne({ _id: "current" });
      expect(metadata?.version).toBe(6);
    });
  });

  describe("durable cursor storage", () => {
    const cursorChain = `chain-cursor-${namespace}`;
    const storage = () => new MongoChainCursorStorage(connection, cursorChain);

    it("bootstraps once and treats a concurrent bootstrap as a no-op", async () => {
      const first = await storage().bootstrap(blockHeader(0));
      expect(first).toEqual({
        lastProcessedBlock: 0,
        lastProcessedBlockHash: hashOf(0),
        version: 0,
      });
      // A second instance racing on the same chain adopts the existing state
      // instead of failing on the unique cursor index.
      const second = await storage().bootstrap(blockHeader(0));
      expect(second).toEqual(first);
      await expect(
        models.ObservedBlock.countDocuments({ chain: cursorChain }),
      ).resolves.toBe(1);
    });

    it("advances inside one transaction and rejects stale versions", async () => {
      const before = await storage().read();
      expect(before?.version).toBe(0);
      await storage().advance({
        expectedVersion: 0,
        lastProcessedBlock: 2,
        lastProcessedBlockHash: hashOf(2),
        headers: [blockHeader(1), blockHeader(2)],
      });
      const after = await storage().read();
      expect(after).toEqual({
        lastProcessedBlock: 2,
        lastProcessedBlockHash: hashOf(2),
        version: 1,
      });
      await expect(
        models.ObservedBlock.countDocuments({ chain: cursorChain }),
      ).resolves.toBe(3);
      await expect(
        storage().advance({
          expectedVersion: 0,
          lastProcessedBlock: 2,
          lastProcessedBlockHash: hashOf(2),
          headers: [blockHeader(1), blockHeader(2)],
        }),
      ).rejects.toThrow(ChainCursorConflictError);
    });

    it("treats duplicate delivery of a committed range as benign", async () => {
      // Regression: the identical re-record used to hit the observed-block
      // unique index inside the transaction, which aborts server-side; the
      // in-transaction recovery find then failed with code 251. Classification
      // now happens before the transaction, so the replay advances cleanly.
      await storage().advance({
        expectedVersion: 1,
        lastProcessedBlock: 2,
        lastProcessedBlockHash: hashOf(2),
        headers: [blockHeader(1), blockHeader(2)],
      });
      const after = await storage().read();
      expect(after?.version).toBe(2);
      await expect(
        models.ObservedBlock.countDocuments({ chain: cursorChain }),
      ).resolves.toBe(3);
    });

    it("halts on a conflicting hash recorded for an observed height", async () => {
      const forked: ObservedBlockHeader = {
        blockNumber: 1,
        blockHash: `0x${"f".repeat(64)}`,
        parentHash: hashOf(0),
      };
      await expect(
        storage().advance({
          expectedVersion: 2,
          lastProcessedBlock: 1,
          lastProcessedBlockHash: forked.blockHash,
          headers: [forked],
        }),
      ).rejects.toThrow(ChainDiscontinuityError);
      // The cursor is left before the discontinuity for Phase 07 resolution.
      const after = await storage().read();
      expect(after).toEqual({
        lastProcessedBlock: 2,
        lastProcessedBlockHash: hashOf(2),
        version: 2,
      });
    });

    it("advances again after a halted range when new blocks arrive", async () => {
      await storage().advance({
        expectedVersion: 2,
        lastProcessedBlock: 4,
        lastProcessedBlockHash: hashOf(4),
        headers: [blockHeader(3), blockHeader(4)],
      });
      const after = await storage().read();
      expect(after).toEqual({
        lastProcessedBlock: 4,
        lastProcessedBlockHash: hashOf(4),
        version: 3,
      });
      // A range mixing already-observed and new headers inserts only the new.
      await storage().advance({
        expectedVersion: 3,
        lastProcessedBlock: 5,
        lastProcessedBlockHash: hashOf(5),
        headers: [blockHeader(4), blockHeader(5)],
      });
      await expect(
        models.ObservedBlock.countDocuments({ chain: cursorChain }),
      ).resolves.toBe(6);
    });
  });

  describe("HMAC nonce replay protection", () => {
    it("consumes a nonce atomically and rejects its reuse", async () => {
      const verifier = new IngestionHmacVerifier(connection, {
        config: config.ingestion,
      });
      const nonce = `nonce-${randomBytes(16).toString("base64url")}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = Buffer.from(JSON.stringify({ chain: chainId }), "utf8");
      const request = {
        keyId: config.ingestion.hmacCurrentKeyId,
        timestamp,
        nonce,
        signature: signIngestionPayload(
          config.ingestion.hmacCurrentSecret,
          timestamp,
          nonce,
          body,
        ),
        body,
      };
      await expect(verifier.verify(request)).resolves.toBeUndefined();
      await expect(verifier.verify(request)).rejects.toMatchObject({
        reason: "nonce_reused",
      });
      await expect(
        models.ConsumedHmacNonce.countDocuments({
          keyId: config.ingestion.hmacCurrentKeyId,
          nonce,
        }),
      ).resolves.toBe(1);
    });
  });

  describe("internal ingestion endpoint", () => {
    it("accepts a valid signed event and persists it verbatim", async () => {
      const payload = eventInput({ transactionHash: txOf(2) });
      const { raw, headers } = signed(payload);
      const response = await postEvent(raw, headers);
      const expectedEventId = deriveEventId(chainId, txOf(2), 0);
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ eventId: expectedEventId, replayed: false });
      const stored = await models.OnChainEvent.findOne({
        eventId: expectedEventId,
      }).lean();
      expect(stored).toMatchObject({
        chain: chainId,
        normalizedContractAddress: eventOnlyContract,
        normalizedFromAddress: sender,
        normalizedToAddress: recipient,
        amount: "900",
        canonical: true,
      });
      expect(stored?.rawEvent).toEqual(payload.rawEvent);
      expect(enqueued).toContain(expectedEventId);
    });

    it("persists confirmationsAtIngest when supplied", async () => {
      const payload = eventInput({
        transactionHash: txOf(3),
        confirmationsAtIngest: 12,
      });
      const { raw, headers } = signed(payload);
      const response = await postEvent(raw, headers);
      expect(response.status).toBe(201);
      const stored = await models.OnChainEvent.findOne({
        eventId: deriveEventId(chainId, txOf(3), 0),
      }).lean();
      expect(stored?.confirmationsAtIngest).toBe(12);
    });

    it("returns 200 replayed for a fresh request with the same event identity", async () => {
      const payload = eventInput({ transactionHash: txOf(4) });
      const first = signed(payload);
      const second = signed(payload);
      const firstResponse = await postEvent(first.raw, first.headers);
      const secondResponse = await postEvent(second.raw, second.headers);
      expect(firstResponse.status).toBe(201);
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body).toMatchObject({ replayed: true });
      await expect(
        models.OnChainEvent.countDocuments({ transactionHash: txOf(4) }),
      ).resolves.toBe(1);
    });

    it("rejects a byte-for-byte replayed request via the nonce index", async () => {
      const payload = eventInput({ transactionHash: txOf(5) });
      const { raw, headers } = signed(payload);
      const firstResponse = await postEvent(raw, headers);
      const replayedResponse = await postEvent(raw, headers);
      expect(firstResponse.status).toBe(201);
      expect(replayedResponse.status).toBe(401);
      expect(replayedResponse.body).toMatchObject({
        error: {
          code: "UNAUTHORIZED",
          details: { reason: "nonce_reused" },
        },
      });
      await expect(
        models.OnChainEvent.countDocuments({ transactionHash: txOf(5) }),
      ).resolves.toBe(1);
    });

    it("rejects a tampered body with invalid_signature", async () => {
      const original = eventInput({ transactionHash: txOf(6), amount: "900" });
      const { headers } = signed(original);
      const tampered = Buffer.from(
        JSON.stringify({ ...original, amount: "1" }),
        "utf8",
      );
      const response = await postEvent(tampered, headers);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: {
          code: "UNAUTHORIZED",
          details: { reason: "invalid_signature" },
        },
      });
    });

    it("rejects malformed signature headers before any body handling", async () => {
      const payload = eventInput({ transactionHash: txOf(7) });
      const { raw, headers } = signed(payload as unknown as Record<string, unknown>, {
        signature: "not-a-hex-signature",
      });
      const response = await postEvent(raw, headers);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: {
          code: "UNAUTHORIZED",
          details: { reason: "malformed_headers" },
        },
      });
    });

    it("rejects unknown key ids", async () => {
      const payload = eventInput({ transactionHash: txOf(8) });
      const { raw, headers } = signed(payload as unknown as Record<string, unknown>, {
        keyId: "test-ingest-v9",
      });
      const response = await postEvent(raw, headers);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: {
          code: "UNAUTHORIZED",
          details: { reason: "unknown_key" },
        },
      });
    });

    it("rejects timestamps outside the skew window", async () => {
      const payload = eventInput({ transactionHash: txOf(9) });
      const staleTimestamp = String(
        Math.floor(Date.now() / 1000) - config.ingestion.timestampSkewSec - 60,
      );
      const { raw, headers } = signed(payload as unknown as Record<string, unknown>, {
        timestamp: staleTimestamp,
      });
      const response = await postEvent(raw, headers);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: {
          code: "UNAUTHORIZED",
          details: { reason: "timestamp_skew" },
        },
      });
    });

    it("rejects a schema-invalid but correctly signed body", async () => {
      const payload = eventInput({ transactionHash: txOf(10), amount: "12.5" });
      const { raw, headers } = signed(payload);
      const response = await postEvent(raw, headers);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
        },
      });
      const paths = issuePaths(response.body);
      expect(paths).toContain("amount");
      await expect(
        models.OnChainEvent.countDocuments({ transactionHash: txOf(10) }),
      ).resolves.toBe(0);
    });

    it("rejects malformed JSON with a safe validation envelope", async () => {
      const { headers } = signed({ ignored: true });
      const response = await postEvent("{", headers);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body is invalid",
        },
      });
    });

    it("rejects oversized payloads with 413", async () => {
      const oversize = JSON.stringify({ padding: "x".repeat(70_000) });
      const { headers } = signed({ padding: "x".repeat(70_000) });
      const response = await postEvent(oversize, headers);
      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body is too large",
        },
      });
    });
  });

  describe("ingestion service idempotence", () => {
    it("collapses duplicate delivery onto one record and enqueues on both paths", async () => {
      const enqueuedHere: string[] = [];
      const service = new EventIngestionService(connection, {
        enqueueInterpretation: (eventId) => {
          enqueuedHere.push(eventId);
          return Promise.resolve();
        },
      });
      const input = eventInput({ transactionHash: txOf(11), logIndex: 3 });
      const first = await service.ingest(input);
      const second = await service.ingest(input);
      expect(first.replayed).toBe(false);
      expect(second).toEqual({ eventId: first.eventId, replayed: true });
      expect(first.eventId).toBe(deriveEventId(chainId, txOf(11), 3));
      await expect(
        models.OnChainEvent.countDocuments({ transactionHash: txOf(11) }),
      ).resolves.toBe(1);
      expect(enqueuedHere).toEqual([first.eventId, first.eventId]);
    });

    it("fails closed on a non-canonical amount without persisting", async () => {
      const enqueuedHere: string[] = [];
      const service = new EventIngestionService(connection, {
        enqueueInterpretation: (eventId) => {
          enqueuedHere.push(eventId);
          return Promise.resolve();
        },
      });
      await expect(
        service.ingest(eventInput({ transactionHash: txOf(12), amount: "0900" })),
      ).rejects.toThrow(TypeError);
      await expect(
        models.OnChainEvent.countDocuments({ transactionHash: txOf(12) }),
      ).resolves.toBe(0);
      expect(enqueuedHere).toEqual([]);
    });
  });

  describe("event interpretation", () => {
    const noQueue: EventEnqueuer = {
      enqueueInterpretation: () => Promise.resolve(),
    };
    const ingestion = () => new EventIngestionService(connection, noQueue);

    async function ingestForInterpretation(input: IngestEventInput): Promise<string> {
      const outcome = await ingestion().ingest(input);
      expect(outcome.replayed).toBe(false);
      return outcome.eventId;
    }

    async function persistThenInterpret(
      input: IngestEventInput,
      deltas: BalanceDeltaReader,
    ): Promise<InterpretationOutcome> {
      const eventId = await ingestForInterpretation(input);
      const interpreter = new EventInterpretationService(connection, deltas);
      return interpreter.interpret(eventId, logger);
    }

    it("rejects events on disabled or unknown chains", async () => {
      const outcome = await persistThenInterpret(
        eventInput({ transactionHash: txOf(20), chain: "bitcoin-mainnet" }),
        scriptableDeltaReader(new Map()),
      );
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: "disabled_or_unknown_chain",
        applied: true,
      });
    });

    it("rejects logs whose raw capture does not decode", async () => {
      const outcome = await persistThenInterpret(
        eventInput({ transactionHash: txOf(21), rawEvent: { topics: ["0xdead"] } }),
        scriptableDeltaReader(new Map()),
      );
      expect(outcome).toMatchObject({ status: "rejected", reason: "malformed_log" });
    });

    it("rejects logs whose normalized fields contradict the raw capture", async () => {
      const outcome = await persistThenInterpret(
        eventInput({
          transactionHash: txOf(22),
          // Raw names the stranger; the normalized ingest field names the
          // recipient. The raw capture is the source of truth, so mismatch
          // means malformed.
          rawEvent: transferRaw(sender, stranger, 900n),
        }),
        scriptableDeltaReader(new Map()),
      );
      expect(outcome).toMatchObject({ status: "rejected", reason: "malformed_log" });
    });

    it("rejects events for unknown or disabled token contracts", async () => {
      const outcome = await persistThenInterpret(
        eventInput({
          transactionHash: txOf(23),
          contractAddress: unregisteredContract,
          rawEvent: transferRaw(sender, recipient, 900n),
        }),
        scriptableDeltaReader(new Map()),
      );
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: "unknown_or_disabled_token",
      });
    });

    it("rejects events addressed to unknown recipients", async () => {
      const outcome = await persistThenInterpret(
        eventInput({
          transactionHash: txOf(24),
          toAddress: stranger,
          rawEvent: transferRaw(sender, stranger, 900n),
        }),
        scriptableDeltaReader(new Map()),
      );
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: "unknown_recipient",
      });
    });

    it("accepts event-only tokens without a balance read and stamps the token", async () => {
      const deltas = scriptableDeltaReader(new Map());
      const input = eventInput({ transactionHash: txOf(25) });
      const eventId = await ingestForInterpretation(input);
      const interpreter = new EventInterpretationService(connection, deltas);
      const outcome = await interpreter.interpret(eventId, logger);
      expect(outcome).toEqual({
        eventId,
        status: "accepted",
        applied: true,
      });
      expect(deltas.calls).toEqual([]);
      const stored = await models.OnChainEvent.findOne({ eventId }).lean();
      expect(stored).toMatchObject({
        interpretationStatus: "accepted",
        token: "token-usdc-sepolia",
        interpretationRevision: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        interpretedAt: expect.any(Date) as Date,
      });
    });

    it.each([
      {
        label: "agreeing positive delta",
        seed: 30,
        read: { status: "agreeing", delta: "900" } as BalanceDeltaRead,
        expectedStatus: "accepted",
        expectedReason: undefined as string | undefined,
      },
      {
        label: "provider disagreement",
        seed: 31,
        read: { status: "disagreement" } as BalanceDeltaRead,
        expectedStatus: "review",
        expectedReason: "balance_delta_disagreement",
      },
      {
        label: "providers unavailable",
        seed: 32,
        read: { status: "unavailable" } as BalanceDeltaRead,
        expectedStatus: "review",
        expectedReason: "balance_delta_unavailable",
      },
      {
        label: "agreeing zero delta",
        seed: 33,
        read: { status: "agreeing", delta: "0" } as BalanceDeltaRead,
        expectedStatus: "review",
        expectedReason: "balance_delta_negative",
      },
      {
        label: "agreeing negative delta",
        seed: 34,
        read: { status: "agreeing", delta: "-900" } as BalanceDeltaRead,
        expectedStatus: "review",
        expectedReason: "balance_delta_negative",
      },
    ])(
      "maps a $label read to $expectedStatus",
      async ({ seed, read, expectedStatus, expectedReason }) => {
        const input = eventInput({
          transactionHash: txOf(seed),
          contractAddress: deltaContract,
          rawEvent: transferRaw(sender, recipient, 900n),
        });
        const eventId = await ingestForInterpretation(input);
        const deltas = scriptableDeltaReader(
          new Map([
            [
              deltaKey({
                chain: chainId,
                contractAddress: deltaContract,
                holder: recipient,
                blockNumber: input.blockNumber,
              }),
              read,
            ],
          ]),
        );
        const interpreter = new EventInterpretationService(connection, deltas);
        const outcome = await interpreter.interpret(eventId, logger);
        expect(outcome.status).toBe(expectedStatus);
        expect(deltas.calls).toHaveLength(1);
        if (expectedReason !== undefined) {
          expect(outcome.reason).toBe(expectedReason);
        } else {
          expect(outcome).toMatchObject({ verifiedReceivedAmount: "900" });
        }
      },
    );

    it("treats a non-positive balance delta as review without crashing", async () => {
      // Regression: negative deltas used to be parsed through the non-negative
      // base-unit guard and throw. The judgment now uses plain BigInt.
      const input = eventInput({
        transactionHash: txOf(40),
        contractAddress: deltaContract,
        rawEvent: transferRaw(sender, recipient, 900n),
      });
      const eventId = await ingestForInterpretation(input);
      const deltas = scriptableDeltaReader(
        new Map([
          [
            deltaKey({
              chain: chainId,
              contractAddress: deltaContract,
              holder: recipient,
              blockNumber: input.blockNumber,
            }),
            { status: "agreeing", delta: "-1" },
          ],
        ]),
      );
      const interpreter = new EventInterpretationService(connection, deltas);
      const outcome = await interpreter.interpret(eventId, logger);
      expect(outcome).toMatchObject({
        status: "review",
        reason: "balance_delta_negative",
      });
    });

    it("collapses duplicate queue delivery onto one effective outcome", async () => {
      const input = eventInput({ transactionHash: txOf(41) });
      const eventId = await ingestForInterpretation(input);
      const interpreter = new EventInterpretationService(
        connection,
        scriptableDeltaReader(new Map()),
      );
      const first = await interpreter.interpret(eventId, logger);
      const second = await interpreter.interpret(eventId, logger);
      expect(first.applied).toBe(true);
      expect(second).toEqual({ ...first, applied: false });
      await expect(models.OnChainEvent.countDocuments({ eventId })).resolves.toBe(1);
    });

    it("keeps the first committed outcome when workers race to finalize", async () => {
      const input = eventInput({ transactionHash: txOf(42) });
      const eventId = await ingestForInterpretation(input);
      const winner = new EventInterpretationService(
        connection,
        scriptableDeltaReader(new Map()),
      );
      const firstOutcome = await winner.interpret(eventId, logger);
      expect(firstOutcome.status).toBe("accepted");
      // A late interpreter whose balance read would now say "disagreement"
      // must not overwrite the committed acceptance.
      const deltas = scriptableDeltaReader(
        new Map([
          [
            deltaKey({
              chain: chainId,
              contractAddress: eventOnlyContract,
              holder: recipient,
              blockNumber: input.blockNumber,
            }),
            { status: "disagreement" },
          ],
        ]),
      );
      const late = new EventInterpretationService(connection, deltas);
      const secondOutcome = await late.interpret(eventId, logger);
      expect(secondOutcome).toEqual({ ...firstOutcome, applied: false });
    });
  });

  describe("durable interpretation queue", () => {
    it("collapses duplicate ingestion onto one prefixed job and delivers it once", async () => {
      const redisResource = new RedisResource(config.redis);
      const prefix = `oscar-test-${namespace}`;
      const queue = new EventQueue(redisResource.client, prefix);
      const inspector = new Queue(eventInterpretationQueueName, {
        prefix,
        connection: redisResource.client,
      });
      let worker: EventInterpretationWorkerResource | undefined;
      try {
        await redisResource.start();
        const ingestion = new EventIngestionService(connection, {
          enqueueInterpretation: (eventId) =>
            queue.enqueueInterpretation(eventId).then(() => undefined),
        });
        const first = await ingestion.ingest(eventInput({ transactionHash: txOf(43) }));
        const duplicate = await ingestion.ingest(
          eventInput({ transactionHash: txOf(43) }),
        );
        expect(first.replayed).toBe(false);
        expect(duplicate).toEqual({ eventId: first.eventId, replayed: true });

        // Two enqueues with the deterministic eventId must leave exactly one
        // durable job before any consumer exists.
        const jobCount = await inspector.getJobCountByTypes(
          "waiting",
          "delayed",
          "active",
          "completed",
        );
        expect(jobCount).toBe(1);
        const job = await inspector.getJob(first.eventId);
        expect(job?.id).toBe(first.eventId);

        // The effective Redis key namespace is `${prefix}:event-interpretation`
        // and never BullMQ's default `bull:` prefix.
        const prefixedKeys = await redisResource.client.keys(
          `${prefix}:event-interpretation*`,
        );
        expect(prefixedKeys.length).toBeGreaterThan(0);
        await expect(
          redisResource.client.keys("bull:event-interpretation*"),
        ).resolves.toEqual([]);

        worker = new EventInterpretationWorkerResource({
          redis: redisResource.client,
          queuePrefix: prefix,
          service: new EventInterpretationService(
            connection,
            scriptableDeltaReader(new Map()),
          ),
          logger,
        });
        await worker.start();
        const deadline = Date.now() + 20_000;
        let stored = await models.OnChainEvent.findOne({
          eventId: first.eventId,
        }).lean();
        while (
          (stored?.interpretationStatus as string | undefined) !== "accepted" &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          stored = await models.OnChainEvent.findOne({ eventId: first.eventId }).lean();
        }
        expect(stored).toMatchObject({
          interpretationStatus: "accepted",
          token: "token-usdc-sepolia",
        });
        await expect(
          models.OnChainEvent.countDocuments({ eventId: first.eventId }),
        ).resolves.toBe(1);
      } finally {
        await worker?.stop();
        await queue.close();
        await inspector.close();
        await redisResource.client.del(
          ...(await redisResource.client.keys(`${prefix}:event-interpretation*`)),
        );
        await redisResource.stop();
      }
    });
  });
});
