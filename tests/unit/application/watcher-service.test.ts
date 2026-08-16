import type { Connection } from "mongoose";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { type EnabledRegistryReader } from "../../../src/application/registry/registry-reader.js";
import {
  WatcherService,
  type DecimalVerifier,
  type RegistryChainRecord,
  type RegistrySnapshot,
  type WatcherChainRuntime,
  type WatcherLogDecoder,
  type WatcherStatus,
} from "../../../src/application/watcher/watcher-service.js";
import type { RuntimeConfig } from "../../../src/config/environment.js";
import type {
  BlockHeaderCorroboration,
  ChainAdapter,
  ChainCursorState,
  ChainCursorStorage,
  ChainLogEntry,
  ChainObservationPort,
  ObservedBlockHeader,
  OnChainDepositEvent,
} from "../../../src/domain/chain/chain-adapter.js";
import {
  ChainCursorConflictError,
  ChainDiscontinuityError,
} from "../../../src/domain/chain/chain-adapter.js";
import type { IngestionClient } from "../../../src/infrastructure/http/ingestion-client.js";

const logger = pino({ level: "silent" });

const chainA = "ethereum-sepolia";
const contractA = "0xabcd111111111111111111111111111111111111";
const recipientA = "0x2222222222222222222222222222222222222222";
const genesisParent = `0x${"0".repeat(64)}`;

const hashOf = (blockNumber: number) =>
  `0x${blockNumber.toString(16).padStart(64, "0")}`;

const header = (blockNumber: number, parentHash: string): ObservedBlockHeader => ({
  blockNumber,
  blockHash: hashOf(blockNumber),
  parentHash,
});

const watcherConfig: RuntimeConfig["watcher"] = {
  pollIntervalMs: 1,
  batchSize: 2,
  registryRefreshSec: 3_600,
  initialLookbackBlocks: 0,
};

interface ChainSnapshotOptions {
  readonly chainIds?: readonly string[];
  readonly tokens?: RegistrySnapshot["tokens"];
}

function snapshot(options: ChainSnapshotOptions = {}): RegistrySnapshot {
  const chainIds = options.chainIds ?? [chainA];
  return {
    revision: `revision-${chainIds.join("-")}-${(options.tokens ?? []).length}`,
    loadedAt: new Date("2026-08-15T12:00:00.000Z"),
    chains: chainIds.map((chainId) => ({
      chainId,
      networkFamily: "evm" as const,
      networkChainId: 11155111,
      rpcProviders: [
        { providerId: "rpc-test-a", operatorId: "operator-a" },
        { providerId: "rpc-test-b", operatorId: "operator-b" },
      ],
      requiredConfirmations: 12,
      version: 1,
      verifiedAt: new Date("2026-08-15T00:00:00.000Z"),
    })),
    tokens: options.tokens ?? [],
  };
}

function token(overrides: Partial<RegistrySnapshot["tokens"][number]> = {}) {
  return {
    tokenId: "token-usdc-sepolia",
    chain: chainA,
    symbol: "USDC",
    contractAddress: "0xABCD111111111111111111111111111111111111",
    normalizedContractAddress: contractA,
    decimals: 6,
    verificationPolicy: "event_only" as const,
    version: 1,
    verifiedAt: new Date("2026-08-15T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * Detached connection with working WalletAddress reads and a functional audit
 * chain (head + entries in memory) so decimal-guard exclusions can be asserted
 * without MongoDB.
 */
function fakeConnection(
  walletDocs: { chain: string; normalizedAddress: string }[] = [],
): {
  readonly connection: Connection;
  readonly auditEntries: Record<string, unknown>[];
} {
  const auditEntries: Record<string, unknown>[] = [];
  let auditHead:
    | { scope: string; sequence: number; entryHash: string; version: number }
    | undefined;
  const models: Record<string, unknown> = {};
  const connection = {
    models,
    db: {
      admin: () => ({
        command: () =>
          Promise.resolve({
            isWritablePrimary: true,
            logicalSessionTimeoutMinutes: 30,
            setName: "rs0",
          }),
      }),
    },
    startSession: () =>
      Promise.resolve({
        startTransaction: () => undefined,
        inTransaction: () => false,
        commitTransaction: () => Promise.resolve(),
        abortTransaction: () => Promise.resolve(),
        endSession: () => Promise.resolve(),
      }),
    model(name: string) {
      const existing = models[name];
      if (existing !== undefined) return existing;
      let model: unknown = {};
      if (name === "WalletAddress") {
        model = {
          find: () => ({
            select: () => ({ lean: () => Promise.resolve(walletDocs) }),
          }),
        };
      } else if (name === "AuditLog") {
        model = class AuditLogStub {
          private readonly document: Record<string, unknown>;
          public constructor(document: Record<string, unknown>) {
            this.document = document;
          }
          public save() {
            auditEntries.push(this.document);
            return Promise.resolve(this);
          }
          public toObject() {
            return this.document;
          }
        };
      } else if (name === "AuditChainHead") {
        model = {
          findOneAndUpdate(
            _filter: unknown,
            update: {
              $setOnInsert?: {
                scope: string;
                sequence: number;
                entryHash: string;
                version: number;
              };
            },
          ) {
            if (auditHead === undefined && update.$setOnInsert !== undefined) {
              auditHead = { ...update.$setOnInsert };
            }
            return { lean: () => Promise.resolve(auditHead) };
          },
          updateOne(
            _filter: unknown,
            update: {
              $set: { sequence: number; entryHash: string };
              $inc: { version: number };
            },
          ) {
            if (auditHead !== undefined) {
              auditHead = {
                ...auditHead,
                sequence: update.$set.sequence,
                entryHash: update.$set.entryHash,
                version: auditHead.version + update.$inc.version,
              };
            }
            return Promise.resolve({ modifiedCount: 1 });
          },
        };
      }
      models[name] = model;
      return model;
    },
  } as unknown as Connection;
  return { connection, auditEntries };
}

/**
 * In-memory chain runtime: block map, live head, in-memory cursor with the
 * observed-block continuity rule, scriptable corroboration, and canned logs.
 */
function fakeChainRuntime(chainId: string) {
  const blocks = new Map<number, ObservedBlockHeader>();
  const observed = new Set<string>();
  const logSets: ChainLogEntry[] = [];
  const decimalCalls: { contract: string; decimals: number }[] = [];
  let head = 0;
  let cursor: ChainCursorState | undefined;
  let corroborationFor: (
    header: ObservedBlockHeader,
  ) => BlockHeaderCorroboration = () => "agreeing";

  const observation: ChainObservationPort = {
    getCurrentBlock: () => Promise.resolve(head),
    getBlockHeader: (blockNumber) => {
      const found = blocks.get(blockNumber);
      if (found === undefined) {
        return Promise.reject(new Error(`No block ${blockNumber} in fake chain`));
      }
      return Promise.resolve(found);
    },
    getLogs: (filter) =>
      Promise.resolve(
        logSets.filter(
          (entry) =>
            entry.blockNumber >= filter.fromBlock &&
            entry.blockNumber <= filter.toBlock &&
            filter.contractAddresses.includes(entry.contractAddress),
        ),
      ),
  };

  const cursorStorage: ChainCursorStorage = {
    read: () => Promise.resolve(cursor),
    bootstrap: (anchor) => {
      if (cursor === undefined) {
        cursor = {
          lastProcessedBlock: anchor.blockNumber,
          lastProcessedBlockHash: anchor.blockHash,
          version: 0,
        };
        observed.add(anchor.blockHash);
      }
      return Promise.resolve(cursor);
    },
    advance: ({
      expectedVersion,
      lastProcessedBlock,
      lastProcessedBlockHash,
      headers,
    }) => {
      if (cursor === undefined || expectedVersion !== cursor.version) {
        return Promise.reject(new ChainCursorConflictError("version mismatch"));
      }
      cursor = {
        lastProcessedBlock,
        lastProcessedBlockHash,
        version: cursor.version + 1,
      };
      for (const block of headers) observed.add(block.blockHash);
      return Promise.resolve();
    },
  };

  const adapter: ChainAdapter = {
    chainId,
    init: () => Promise.resolve(),
    getCurrentBlock: () => Promise.resolve(head),
    getConfirmations: () => Promise.resolve(0),
    isCanonical: () => Promise.resolve(true),
    watchDeposits: () => undefined,
    stop: () => Promise.resolve(),
  };

  const decimalVerifier: DecimalVerifier = {
    verifyDecimals: (contract, decimals) => {
      decimalCalls.push({ contract, decimals });
      return Promise.resolve({ verified: true, decimals });
    },
  };

  const runtime: WatcherChainRuntime = {
    chainId,
    adapter,
    observation,
    corroborator: {
      corroborateBlockHeader: (blockHeader) =>
        Promise.resolve(corroborationFor(blockHeader)),
    },
    cursorStorage,
    decimalVerifier,
  };

  return {
    runtime,
    decimalCalls,
    addBlock: (block: ObservedBlockHeader) => {
      blocks.set(block.blockNumber, block);
    },
    addLogs: (...entries: ChainLogEntry[]) => {
      logSets.push(...entries);
    },
    setHead: (value: number) => {
      head = value;
    },
    setCorroboration: (
      fn: (blockHeader: ObservedBlockHeader) => BlockHeaderCorroboration,
    ) => {
      corroborationFor = fn;
    },
    getCursor: () => cursor,
  };
}

function logEntry(overrides: Partial<ChainLogEntry>): ChainLogEntry {
  return {
    contractAddress: contractA,
    transactionHash: `0x${"3".repeat(64)}`,
    logIndex: 0,
    blockNumber: 1,
    blockHash: hashOf(1),
    topics: [],
    data: "0x",
    raw: { provider: "fake" },
    ...overrides,
  };
}

function recordingDecoder(): {
  readonly decoder: WatcherLogDecoder;
  readonly decoded: ChainLogEntry[];
  readonly skipped: ChainLogEntry[];
} {
  const decoded: ChainLogEntry[] = [];
  const skipped: ChainLogEntry[] = [];
  const decoder: WatcherLogDecoder = {
    transferTopic: "0xtransfer",
    decodeTransfer: (entry) => {
      if (entry.topics.length === 0) {
        skipped.push(entry);
        return undefined;
      }
      decoded.push(entry);
      return {
        fromAddress: `0x${"1".repeat(40)}`,
        toAddress: entry.topics[0] ?? "",
        amount: entry.data,
      };
    },
  };
  return { decoder, decoded, skipped };
}

async function until(
  predicate: () => boolean,
  timeoutMs = 2_000,
  message = "condition was not met",
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function service(options: {
  readonly connection: Connection;
  readonly runtimes: Map<string, ReturnType<typeof fakeChainRuntime>>;
  readonly registry?: { snapshots: RegistrySnapshot[]; createFailsFor?: string };
  readonly decoder?: WatcherLogDecoder;
  readonly config?: RuntimeConfig["watcher"];
}) {
  const snapshots = [...(options.registry?.snapshots ?? [snapshot()])];
  const submitted: OnChainDepositEvent[] = [];
  const createdChains: string[] = [];
  const ingestionClient: IngestionClient = {
    submitEvent: (event) => {
      submitted.push(event);
      return Promise.resolve({ eventId: `event_${submitted.length}`, replayed: false });
    },
  };
  const registryReader = {
    refresh: () =>
      Promise.resolve(snapshots.shift() ?? snapshots[snapshots.length - 1]),
  } as unknown as EnabledRegistryReader;
  const service = new WatcherService({
    connection: options.connection,
    config: options.config ?? watcherConfig,
    ingestionClient,
    runtimeFactory: {
      create: (chain) => {
        if (options.registry?.createFailsFor === chain.chainId) {
          return Promise.reject(new Error("adapter init failed"));
        }
        const harness = options.runtimes.get(chain.chainId);
        if (harness === undefined) {
          return Promise.reject(new Error(`No fake runtime for ${chain.chainId}`));
        }
        createdChains.push(chain.chainId);
        return Promise.resolve(harness.runtime);
      },
    },
    logger,
    registryReader,
    ...(options.decoder === undefined ? {} : { logDecoder: options.decoder }),
  });
  return { service, submitted, createdChains };
}

const readyWallet = [{ chain: chainA, normalizedAddress: recipientA }];

describe("WatcherService status and readiness", () => {
  it("is not ready before the first registry snapshot", () => {
    const { connection } = fakeConnection();
    const { service: watcher } = service({
      connection,
      runtimes: new Map(),
    });
    expect(watcher.isReady()).toBe(false);
    expect(watcher.getStatus()).toMatchObject({
      started: false,
      registryRevision: undefined,
      enabledChainCount: 0,
      watchableChainCount: 0,
    });
  });

  it("is ready with zero enabled chains once the registry has loaded", async () => {
    const { connection } = fakeConnection();
    const { service: watcher } = service({
      connection,
      runtimes: new Map(),
      registry: { snapshots: [snapshot({ chainIds: [], tokens: [] })] },
    });
    await watcher.refreshRegistry();
    expect(watcher.isReady()).toBe(true);
    expect(watcher.getStatus().registryRevision).toBe("revision--0");
  });

  it("requires at least one watchable chain when chains are enabled", async () => {
    const { connection } = fakeConnection();
    const { service: watcher } = service({
      connection,
      runtimes: new Map([[chainA, fakeChainRuntime(chainA)]]),
      registry: { snapshots: [snapshot({ chainIds: [chainA], tokens: [] })] },
    });
    await watcher.refreshRegistry();
    expect(watcher.getStatus()).toMatchObject({
      enabledChainCount: 1,
      watchableChainCount: 0,
    });
    expect(watcher.isReady()).toBe(false);
  });
});

describe("WatcherService registry refresh", () => {
  it("passes the registry chain record to the runtime factory", async () => {
    const { connection } = fakeConnection();
    const harness = fakeChainRuntime(chainA);
    const seen: RegistryChainRecord[] = [];
    const reader = {
      refresh: () => Promise.resolve(snapshot({ tokens: [token()] })),
    } as unknown as EnabledRegistryReader;
    const watcher = new WatcherService({
      connection,
      config: watcherConfig,
      ingestionClient: {
        submitEvent: () => Promise.resolve({ eventId: "event_x", replayed: false }),
      },
      runtimeFactory: {
        create: (chain) => {
          seen.push(chain);
          return Promise.resolve(harness.runtime);
        },
      },
      logger,
      registryReader: reader,
    });
    await watcher.refreshRegistry();
    expect(seen).toEqual([
      expect.objectContaining({
        chainId: chainA,
        networkFamily: "evm",
        networkChainId: 11155111,
        requiredConfirmations: 12,
        rpcProviders: expect.arrayContaining([
          expect.objectContaining({ providerId: "rpc-test-a" }),
        ]) as RegistryChainRecord["rpcProviders"],
      }),
    ]);
  });

  it("adds the token contract and wallet recipients to the watchlist", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    const { service: watcher } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [snapshot({ tokens: [token()] })] },
    });
    await watcher.refreshRegistry();
    const status = watcher.getStatus();
    expect(status.watchableChainCount).toBe(1);
    expect(status.excludedTokenCount).toBe(0);
    expect(watcher.isReady()).toBe(true);
    expect(harness.decimalCalls).toEqual([{ contract: contractA, decimals: 6 }]);
  });

  it("does not re-verify a token until its version changes", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    const first = snapshot({ tokens: [token()] });
    const unchanged = { ...first, revision: "revision-unchanged" };
    const bumped = {
      ...first,
      revision: "revision-bumped",
      tokens: [token({ version: 2 })],
    };
    const { service: watcher } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [first, unchanged, bumped] },
    });
    await watcher.refreshRegistry();
    await watcher.refreshRegistry();
    expect(harness.decimalCalls).toHaveLength(1);
    await watcher.refreshRegistry();
    expect(harness.decimalCalls).toHaveLength(2);
    expect(watcher.getStatus().excludedTokenCount).toBe(0);
  });

  it("excludes a token on decimal mismatch with exactly one audit entry", async () => {
    const { connection, auditEntries } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    harness.runtime.decimalVerifier.verifyDecimals = () =>
      Promise.resolve({ verified: false, reason: "decimal_mismatch" });
    const first = snapshot({ tokens: [token()] });
    const unchanged = { ...first, revision: "revision-unchanged" };
    const { service: watcher } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [first, unchanged] },
    });
    await watcher.refreshRegistry();
    const status = watcher.getStatus();
    expect(status.excludedTokenCount).toBe(1);
    expect(status.watchableChainCount).toBe(0);
    expect(watcher.isReady()).toBe(false);
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      scope: "platform",
      entityType: "Token",
      entityId: "token-usdc-sepolia",
      action: "watcher.token_excluded",
      actorType: "system",
      actorId: "watcher",
      metadata: expect.objectContaining({
        chain: chainA,
        contractAddress: contractA,
        expectedDecimals: 6,
        reason: "decimal_mismatch",
      }) as Record<string, unknown>,
    });
    // A still-excluded token at the same version re-verifies but does not
    // duplicate the audit entry.
    await watcher.refreshRegistry();
    expect(auditEntries).toHaveLength(1);
    expect(watcher.getStatus().excludedTokenCount).toBe(1);
  });

  it("treats an unexpected decimal guard failure as an exclusion", async () => {
    const { connection, auditEntries } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    harness.runtime.decimalVerifier.verifyDecimals = () =>
      Promise.reject(new Error("boom"));
    const { service: watcher } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [snapshot({ tokens: [token()] })] },
    });
    await watcher.refreshRegistry();
    expect(watcher.getStatus().excludedTokenCount).toBe(1);
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      metadata: expect.objectContaining({
        reason: "provider_unavailable",
      }) as Record<string, unknown>,
    });
  });

  it("lets a previously excluded token rejoin once it verifies again", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    let calls = 0;
    harness.runtime.decimalVerifier.verifyDecimals = (_contract, decimals) => {
      calls += 1;
      return Promise.resolve(
        calls < 2
          ? { verified: false, reason: "metadata_missing" }
          : { verified: true, decimals },
      );
    };
    const first = snapshot({ tokens: [token()] });
    const unchanged = { ...first, revision: "revision-unchanged" };
    const { service: watcher } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [first, unchanged] },
    });
    await watcher.refreshRegistry();
    expect(watcher.getStatus().excludedTokenCount).toBe(1);
    await watcher.refreshRegistry();
    expect(calls).toBe(2);
    expect(watcher.getStatus()).toMatchObject({
      excludedTokenCount: 0,
      watchableChainCount: 1,
    });
  });

  it("retires a chain removed from the registry", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    let stopped = false;
    harness.runtime.adapter.stop = () => {
      stopped = true;
      return Promise.resolve();
    };
    const first = snapshot({ tokens: [token()] });
    const emptied = { ...first, revision: "revision-emptied", chains: [], tokens: [] };
    const { service: watcher } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [first, emptied] },
    });
    await watcher.refreshRegistry();
    expect(watcher.getStatus().enabledChainCount).toBe(1);
    await watcher.refreshRegistry();
    expect(stopped).toBe(true);
    expect(watcher.getStatus()).toMatchObject({
      enabledChainCount: 0,
      watchableChainCount: 0,
    });
    expect(watcher.isReady()).toBe(true);
  });

  it("skips a chain whose runtime cannot be created and keeps the rest", async () => {
    const { connection } = fakeConnection();
    const polygon = "polygon-mainnet";
    const harness = fakeChainRuntime(polygon);
    const { service: watcher } = service({
      connection,
      runtimes: new Map([[polygon, harness]]),
      registry: {
        snapshots: [
          snapshot({
            chainIds: [chainA, polygon],
            tokens: [token({ tokenId: "token-usdc-polygon", chain: polygon })],
          }),
        ],
        createFailsFor: chainA,
      },
    });
    await watcher.refreshRegistry();
    const status = watcher.getStatus();
    expect(status.enabledChainCount).toBe(2);
    expect(status.watchableChainCount).toBe(1);
    expect(status.excludedTokenCount).toBe(0);
    expect(watcher.isReady()).toBe(true);
  });
});

describe("WatcherService poll pipeline", () => {
  it("bootstraps the cursor at head minus lookback, then ingests relevant transfers in order", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    for (const blockNumber of [0, 1, 2, 3]) {
      harness.addBlock(
        header(
          blockNumber,
          blockNumber === 0 ? genesisParent : hashOf(blockNumber - 1),
        ),
      );
    }
    harness.setHead(3);
    harness.addLogs(
      // Deliberately out of order: the watcher must sort by block/logIndex.
      logEntry({
        blockNumber: 3,
        blockHash: hashOf(3),
        logIndex: 0,
        topics: [recipientA],
        data: "300",
      }),
      logEntry({
        blockNumber: 1,
        blockHash: hashOf(1),
        logIndex: 0,
        topics: [recipientA],
        data: "100",
      }),
      logEntry({
        blockNumber: 2,
        blockHash: hashOf(2),
        logIndex: 0,
        topics: [recipientA],
        data: "200",
      }),
    );
    const { decoder } = recordingDecoder();
    const { service: watcher, submitted } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [snapshot({ tokens: [token()] })] },
      decoder,
      // Lookback 3 anchors the cursor at block 0 so the block-1 log is
      // included; the anchor block itself is treated as already processed.
      config: { ...watcherConfig, initialLookbackBlocks: 3 },
    });
    await watcher.start();
    try {
      await until(() => submitted.length >= 3, 2_000, "three events submitted");
    } finally {
      await watcher.stop();
    }
    // Anchor at head(3) - lookback(3) = block 0; two batches of size 2 carry
    // the cursor through block 3.
    expect(harness.getCursor()).toMatchObject({ lastProcessedBlock: 3, version: 2 });
    expect(submitted.map((event) => event.amount)).toEqual(["100", "200", "300"]);
    expect(submitted.map((event) => event.blockNumber)).toEqual([1, 2, 3]);
    for (const event of submitted) {
      expect(event).toMatchObject({
        chain: chainA,
        contractAddress: contractA,
        toAddress: recipientA,
        rawEvent: { provider: "fake" },
      });
    }
  });

  it("filters out transfers to non-recipient addresses and undecodable logs", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    for (const blockNumber of [0, 1]) {
      harness.addBlock(
        header(
          blockNumber,
          blockNumber === 0 ? genesisParent : hashOf(blockNumber - 1),
        ),
      );
    }
    harness.setHead(1);
    harness.addLogs(
      logEntry({ blockNumber: 1, logIndex: 0, topics: [recipientA], data: "100" }),
      logEntry({
        blockNumber: 1,
        logIndex: 1,
        topics: [`0x${"9".repeat(40)}`],
        data: "999",
        transactionHash: `0x${"4".repeat(64)}`,
      }),
      logEntry({ blockNumber: 1, logIndex: 2, topics: [] }),
    );
    const { decoder, decoded, skipped } = recordingDecoder();
    const { service: watcher, submitted } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [snapshot({ tokens: [token()] })] },
      decoder,
      config: { ...watcherConfig, initialLookbackBlocks: 1 },
    });
    await watcher.start();
    try {
      await until(
        () => harness.getCursor()?.lastProcessedBlock === 1,
        2_000,
        "batch advanced",
      );
      // Give the (already complete) batch a beat; no further events may arrive.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await watcher.stop();
    }
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ toAddress: recipientA, amount: "100" });
    expect(decoded).toHaveLength(2);
    expect(skipped).toHaveLength(1);
  });

  it("defers bootstrap until the anchor block is corroborated", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    for (const blockNumber of [0, 1]) {
      harness.addBlock(
        header(
          blockNumber,
          blockNumber === 0 ? genesisParent : hashOf(blockNumber - 1),
        ),
      );
    }
    harness.setHead(1);
    harness.addLogs(
      logEntry({ blockNumber: 1, logIndex: 0, topics: [recipientA], data: "100" }),
    );
    let corroborations = 0;
    harness.setCorroboration(() => {
      corroborations += 1;
      // The first anchor corroboration fails; the retry agrees.
      return corroborations === 1 ? "unavailable" : "agreeing";
    });
    const { decoder } = recordingDecoder();
    const { service: watcher, submitted } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [snapshot({ tokens: [token()] })] },
      decoder,
      config: { ...watcherConfig, initialLookbackBlocks: 1 },
    });
    await watcher.start();
    try {
      await until(() => corroborations >= 2, 2_000, "anchor re-corroborated");
      await until(() => submitted.length >= 1, 2_000, "event ingested after recovery");
    } finally {
      await watcher.stop();
    }
    expect(submitted).toHaveLength(1);
    expect(harness.getCursor()).toMatchObject({ lastProcessedBlock: 1 });
  });

  it("discards a batch without advancing when a header is not corroborated", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    for (const blockNumber of [0, 1]) {
      harness.addBlock(
        header(
          blockNumber,
          blockNumber === 0 ? genesisParent : hashOf(blockNumber - 1),
        ),
      );
    }
    harness.setHead(1);
    harness.setCorroboration((blockHeader) =>
      blockHeader.blockNumber === 1 ? "disagreement" : "agreeing",
    );
    const { service: watcher, submitted } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [snapshot({ tokens: [token()] })] },
      config: { ...watcherConfig, initialLookbackBlocks: 1 },
    });
    await watcher.start();
    try {
      // Bootstrap corroborates block 0 fine; block 1 keeps failing corroboration.
      await until(
        () => harness.getCursor() !== undefined,
        2_000,
        "cursor bootstrapped",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await watcher.stop();
    }
    expect(harness.getCursor()).toMatchObject({ lastProcessedBlock: 0, version: 0 });
    expect(submitted).toEqual([]);
    expect(watcher.getStatus().haltedChains).toEqual([]);
  });

  it("halts the chain at a parent-hash discontinuity and leaves the cursor before it", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    harness.addBlock(header(0, genesisParent));
    harness.addBlock(header(1, hashOf(0)));
    harness.setHead(1);
    const { service: watcher, submitted } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [snapshot({ tokens: [token()] })] },
      config: { ...watcherConfig, initialLookbackBlocks: 1 },
    });
    await watcher.start();
    try {
      await until(
        () => harness.getCursor()?.lastProcessedBlock === 1,
        2_000,
        "block 1 advanced",
      );
      // Deep reorg: block 2 arrives with a parent the watcher never observed.
      harness.addBlock({
        blockNumber: 2,
        blockHash: hashOf(2),
        parentHash: `0x${"f".repeat(64)}`,
      });
      harness.setHead(2);
      await until(
        () => watcher.getStatus().haltedChains.includes(chainA),
        2_000,
        "chain halted",
      );
    } finally {
      await watcher.stop();
    }
    expect(watcher.getStatus()).toMatchObject({
      haltedChains: [chainA],
      watchableChainCount: 0,
    });
    expect(watcher.isReady()).toBe(false);
    // The cursor is left before the discontinuity for Phase 07 resolution.
    expect(harness.getCursor()).toMatchObject({ lastProcessedBlock: 1, version: 1 });
    expect(submitted).toEqual([]);
  });

  it("rereads the cursor after a concurrent advance instead of failing", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    for (const blockNumber of [0, 1, 2, 3]) {
      harness.addBlock(
        header(
          blockNumber,
          blockNumber === 0 ? genesisParent : hashOf(blockNumber - 1),
        ),
      );
    }
    harness.setHead(3);
    // Simulate a second watcher instance committing the first range first:
    // the advance succeeds in storage but reports a conflict to this instance.
    let conflictNext = true;
    const realAdvance = harness.runtime.cursorStorage.advance.bind(
      harness.runtime.cursorStorage,
    );
    const storage: ChainCursorStorage = {
      read: () => harness.runtime.cursorStorage.read(),
      bootstrap: (anchor) => harness.runtime.cursorStorage.bootstrap(anchor),
      advance: async (advanceInput) => {
        if (conflictNext) {
          conflictNext = false;
          await realAdvance(advanceInput);
          throw new ChainCursorConflictError("advanced concurrently");
        }
        return realAdvance(advanceInput);
      },
    };
    const runtime: WatcherChainRuntime = { ...harness.runtime, cursorStorage: storage };
    const runtimes = new Map([[chainA, { ...harness, runtime }]]);
    const { decoder } = recordingDecoder();
    const { service: watcher, submitted } = service({
      connection,
      runtimes,
      registry: { snapshots: [snapshot({ tokens: [token()] })] },
      decoder,
      config: { ...watcherConfig, initialLookbackBlocks: 3 },
    });
    harness.addLogs(
      logEntry({ blockNumber: 1, logIndex: 0, topics: [recipientA], data: "100" }),
    );
    await watcher.start();
    try {
      await until(
        () => harness.getCursor()?.lastProcessedBlock === 3,
        2_000,
        "cursor reached block 3 after conflict",
      );
    } finally {
      await watcher.stop();
    }
    expect(submitted.length).toBeGreaterThanOrEqual(1);
    // A conflict replays the range by design; the replayed submission is the
    // same event identity and collapses to one unique ingestion.
    const unique = new Set(
      submitted.map(
        (event) => `${event.chain}:${event.transactionHash}:${event.logIndex}`,
      ),
    );
    expect(unique.size).toBe(1);
    // Storage absorbed one extra advance for the conflicting first range;
    // two real advances carry the cursor to block 3.
    expect(harness.getCursor()?.version).toBe(2);
  });

  it("retries after an ingestion failure without advancing the cursor", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    for (const blockNumber of [0, 1]) {
      harness.addBlock(
        header(
          blockNumber,
          blockNumber === 0 ? genesisParent : hashOf(blockNumber - 1),
        ),
      );
    }
    harness.setHead(1);
    harness.addLogs(
      logEntry({ blockNumber: 1, logIndex: 0, topics: [recipientA], data: "100" }),
    );
    const snapshots = [snapshot({ tokens: [token()] })];
    const reader = {
      refresh: () => Promise.resolve(snapshots[0]),
    } as unknown as EnabledRegistryReader;
    const { decoder } = recordingDecoder();
    let failNext = true;
    const submitted: OnChainDepositEvent[] = [];
    const watcher = new WatcherService({
      connection,
      config: { ...watcherConfig, initialLookbackBlocks: 1 },
      ingestionClient: {
        submitEvent: (event) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error("endpoint down"));
          }
          submitted.push(event);
          return Promise.resolve({ eventId: "event_x", replayed: false });
        },
      },
      runtimeFactory: { create: () => Promise.resolve(harness.runtime) },
      logger,
      registryReader: reader,
      logDecoder: decoder,
    });
    await watcher.start();
    try {
      await until(() => submitted.length >= 1, 2_000, "event ingested after retry");
      await until(
        () => harness.getCursor()?.lastProcessedBlock === 1,
        2_000,
        "cursor advanced after recovery",
      );
    } finally {
      await watcher.stop();
    }
    // The failed attempt did not advance the cursor; the retry re-submitted.
    expect(submitted).toHaveLength(1);
    expect(harness.getCursor()?.version).toBe(1);
    expect(watcher.getStatus().haltedChains).toEqual([]);
  });

  it("never ingests when a chain has no watched contracts", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    for (const blockNumber of [0, 1]) {
      harness.addBlock(
        header(
          blockNumber,
          blockNumber === 0 ? genesisParent : hashOf(blockNumber - 1),
        ),
      );
    }
    harness.setHead(1);
    harness.addLogs(
      logEntry({ blockNumber: 1, logIndex: 0, topics: [recipientA], data: "100" }),
    );
    const { service: watcher, submitted } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [snapshot({ tokens: [] })] },
      config: { ...watcherConfig, initialLookbackBlocks: 1 },
    });
    await watcher.start();
    try {
      await until(
        () => harness.getCursor()?.lastProcessedBlock === 1,
        2_000,
        "batch advanced",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await watcher.stop();
    }
    expect(submitted).toEqual([]);
  });

  it("reports started and stops cleanly", async () => {
    const { connection } = fakeConnection(readyWallet);
    const harness = fakeChainRuntime(chainA);
    const { service: watcher, createdChains } = service({
      connection,
      runtimes: new Map([[chainA, harness]]),
      registry: { snapshots: [snapshot({ tokens: [token()] })] },
    });
    await watcher.start();
    const status: WatcherStatus = watcher.getStatus();
    expect(status.started).toBe(true);
    expect(createdChains).toEqual([chainA]);
    await watcher.stop();
    expect(watcher.getStatus().started).toBe(false);
  });
});

describe("WatcherService chain error classes", () => {
  it("exposes typed errors for discontinuity and cursor conflict", () => {
    const discontinuity = new ChainDiscontinuityError("fork");
    const conflict = new ChainCursorConflictError("stale version");
    expect(discontinuity.name).toBe("ChainDiscontinuityError");
    expect(conflict.name).toBe("ChainCursorConflictError");
    expect(discontinuity).toBeInstanceOf(Error);
    expect(conflict).toBeInstanceOf(Error);
  });
});
