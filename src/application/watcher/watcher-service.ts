import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import type {
  BlockHeaderCorroborator,
  ChainAdapter,
  ChainCursorStorage,
  ChainLogEntry,
  ChainObservationPort,
  ObservedBlockHeader,
} from "../../domain/chain/chain-adapter.js";
import {
  ChainCursorConflictError,
  ChainDiscontinuityError,
} from "../../domain/chain/chain-adapter.js";
import { appendAuditEntry } from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { decodeTransferLog } from "../../infrastructure/chain/evm-chain-adapter.js";
import { erc20TransferTopic } from "../../infrastructure/chain/evm-registry-verifier.js";
import type { DecimalGuardOutcome } from "../../infrastructure/chain/decimal-guard.js";
import type { IngestionClient } from "../../infrastructure/http/ingestion-client.js";
import { EnabledRegistryReader } from "../registry/registry-reader.js";

export type RegistrySnapshot = Awaited<ReturnType<EnabledRegistryReader["refresh"]>>;
export type RegistryChainRecord = RegistrySnapshot["chains"][number];

export interface DecimalVerifier {
  verifyDecimals(
    contractAddress: string,
    expectedDecimals: number,
  ): Promise<DecimalGuardOutcome>;
}

/** Per-chain components the watcher pipeline operates on (ADR 0009). */
export interface WatcherChainRuntime {
  readonly chainId: string;
  readonly adapter: ChainAdapter;
  readonly observation: ChainObservationPort;
  readonly corroborator: BlockHeaderCorroborator;
  readonly cursorStorage: ChainCursorStorage;
  readonly decimalVerifier: DecimalVerifier;
}

/** Builds a chain runtime for a registry chain record (adapter init included). */
export interface WatcherChainRuntimeFactory {
  create(chain: RegistryChainRecord): Promise<WatcherChainRuntime>;
}

export interface WatcherLogDecoder {
  readonly transferTopic: string;
  decodeTransfer(entry: ChainLogEntry):
    | {
        readonly fromAddress: string;
        readonly toAddress: string;
        readonly amount: string;
      }
    | undefined;
}

/** EVM decoder wired to the shared Phase 04 transfer topic and decoder. */
export const evmWatcherLogDecoder: WatcherLogDecoder = {
  transferTopic: erc20TransferTopic,
  decodeTransfer: decodeTransferLog,
};

export interface WatcherStatus {
  readonly started: boolean;
  readonly registryRevision: string | undefined;
  readonly enabledChainCount: number;
  readonly watchableChainCount: number;
  readonly haltedChains: readonly string[];
  readonly excludedTokenCount: number;
}

interface ChainWatchState {
  readonly runtime: WatcherChainRuntime;
  loop: Promise<void> | undefined;
  halted: boolean;
  retired: boolean;
  // ERC-20 deposit contracts to filter `eth_getLogs` on.
  contracts: readonly string[];
  // Whether at least one enabled native token exists on this chain (ADR 0018);
  // drives the full-block value-transfer scan.
  native: boolean;
  recipients: ReadonlySet<string>;
  excludedTokens: ReadonlyMap<string, string>;
}

function sleep(ms: number, isStopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      if (isStopped() || Date.now() - startedAt >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(100, ms - (Date.now() - startedAt)));
    };
    setTimeout(tick, Math.min(100, ms));
  });
}

export interface WatcherServiceOptions {
  readonly connection: Connection;
  readonly config: RuntimeConfig["watcher"];
  readonly ingestionClient: IngestionClient;
  readonly runtimeFactory: WatcherChainRuntimeFactory;
  readonly logger: Logger;
  readonly logDecoder?: WatcherLogDecoder;
  readonly registryReader?: EnabledRegistryReader;
  /**
   * Fork resolution hook (ADR 0012). When absent the Phase 06 behavior
   * stands: a discontinuity halts the chain indefinitely.
   */
  readonly reorgResolver?: {
    resolve(runtime: {
      readonly chainId: string;
      readonly observation: ChainObservationPort;
      readonly corroborator: BlockHeaderCorroborator;
      readonly cursorStorage: ChainCursorStorage;
    }): Promise<"resolved" | "unresolvable">;
  };
}

/**
 * Durable watcher pipeline (ADR 0009). Refreshes the enabled registry and the
 * assigned wallet-address set on a bounded interval, applies the decimal guard
 * to added/changed/excluded tokens, and runs one cursor-based poll loop per
 * chain: headers are checked for parent-hash continuity and corroborated
 * through an independent provider before logs are fetched, relevant transfers
 * are submitted to the ingestion endpoint, and the cursor advances only after
 * every event in the range is acknowledged.
 */
export class WatcherService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #registryReader: EnabledRegistryReader;
  readonly #config: RuntimeConfig["watcher"];
  readonly #ingestionClient: IngestionClient;
  readonly #runtimeFactory: WatcherChainRuntimeFactory;
  readonly #logger: Logger;
  readonly #logDecoder: WatcherLogDecoder;
  readonly #reorgResolver: WatcherServiceOptions["reorgResolver"];
  readonly #chains = new Map<string, ChainWatchState>();
  readonly #tokenVersions = new Map<string, number>();
  #registryRevision: string | undefined;
  #enabledChainCount = 0;
  #started = false;
  #stopping = false;
  #refreshTimer: NodeJS.Timeout | undefined;
  #refreshInFlight: Promise<void> | undefined;

  public constructor(options: WatcherServiceOptions) {
    this.#connection = options.connection;
    this.#models = registerPersistenceModels(options.connection);
    this.#registryReader =
      options.registryReader ?? new EnabledRegistryReader(options.connection);
    this.#config = options.config;
    this.#ingestionClient = options.ingestionClient;
    this.#runtimeFactory = options.runtimeFactory;
    this.#logger = options.logger.child({ component: "watcher-service" });
    this.#logDecoder = options.logDecoder ?? evmWatcherLogDecoder;
    this.#reorgResolver = options.reorgResolver;
  }

  public getStatus(): WatcherStatus {
    const states = [...this.#chains.values()];
    return {
      started: this.#started,
      registryRevision: this.#registryRevision,
      enabledChainCount: this.#enabledChainCount,
      watchableChainCount: states.filter(
        (state) => !state.halted && (state.contracts.length > 0 || state.native),
      ).length,
      haltedChains: states
        .filter((state) => state.halted)
        .map((state) => state.runtime.chainId),
      excludedTokenCount: states.reduce(
        (total, state) => total + state.excludedTokens.size,
        0,
      ),
    };
  }

  /**
   * Ready once the first registry snapshot has loaded and at least one enabled
   * chain is watchable; with no enabled chains there is nothing to watch.
   * Decimal-guard exclusions and halts degrade readiness through the
   * watchable-chain count rather than crashing the process.
   */
  public isReady(): boolean {
    if (this.#registryRevision === undefined) return false;
    if (this.#enabledChainCount === 0) return true;
    return this.getStatus().watchableChainCount >= 1;
  }

  public async start(): Promise<void> {
    this.#stopping = false;
    // Mark started before the first refresh: chains discovered by the initial
    // registry snapshot only receive poll loops when the service is started.
    this.#started = true;
    await this.refreshRegistry();
    this.#refreshTimer = setInterval(() => {
      this.#refreshInFlight ??= this.refreshRegistry()
        .catch((error: unknown) => {
          this.#logger.warn({ err: error }, "Registry refresh failed");
        })
        .finally(() => {
          this.#refreshInFlight = undefined;
        });
    }, this.#config.registryRefreshSec * 1_000);
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#refreshTimer !== undefined) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    if (this.#refreshInFlight !== undefined) {
      await this.#refreshInFlight;
    }
    const states = [...this.#chains.values()];
    await Promise.all(states.map((state) => this.#stopChain(state)));
    this.#started = false;
  }

  /**
   * Reload the enabled registry and wallet-address set, apply the decimal
   * guard, and atomically swap the active watchlist between poll cycles.
   * Chains added to the registry get runtimes (and poll loops) without a
   * restart; chains removed from the registry are retired.
   */
  public async refreshRegistry(): Promise<void> {
    const snapshot = await this.#registryReader.refresh();
    const walletDocs = await this.#models.WalletAddress.find({
      status: { $in: ["available", "assigned"] },
    })
      .select({ chain: 1, normalizedAddress: 1 })
      .lean();
    const recipientsByChain = new Map<string, Set<string>>();
    for (const doc of walletDocs) {
      const recipients = recipientsByChain.get(doc.chain) ?? new Set<string>();
      recipients.add(doc.normalizedAddress.toLowerCase());
      recipientsByChain.set(doc.chain, recipients);
    }

    const enabledChainIds = new Set(snapshot.chains.map((chain) => chain.chainId));
    for (const [chainId, state] of [...this.#chains]) {
      if (!enabledChainIds.has(chainId)) {
        this.#logger.info({ chainId }, "Chain removed from registry; retiring watcher");
        await this.#stopChain(state);
        this.#chains.delete(chainId);
        for (const token of snapshot.tokens) {
          if (token.chain === chainId) this.#tokenVersions.delete(token.tokenId);
        }
      }
    }
    for (const chain of snapshot.chains) {
      if (this.#chains.has(chain.chainId)) continue;
      try {
        const runtime = await this.#runtimeFactory.create(chain);
        const state: ChainWatchState = {
          runtime,
          loop: undefined,
          halted: false,
          retired: false,
          contracts: [],
          native: false,
          recipients: new Set<string>(),
          excludedTokens: new Map(),
        };
        this.#chains.set(chain.chainId, state);
        if (this.#started) this.#startChainLoop(state);
      } catch (error: unknown) {
        // Fail closed for this chain only: readiness degrades, other chains proceed.
        this.#logger.error(
          { err: error, chainId: chain.chainId },
          "Chain watcher startup failed; chain is not watchable",
        );
      }
    }

    const excludedByChain = new Map<string, Map<string, string>>();
    const contractsByChain = new Map<string, string[]>();
    const nativeByChain = new Map<string, boolean>();
    for (const token of snapshot.tokens) {
      const state = this.#chains.get(token.chain);
      if (state === undefined) continue;
      // Native tokens have no contract to decimal-guard (ADR 0018); their
      // watch set is derived from wallet recipients, not a contract address.
      if (token.assetType === "native") {
        this.#tokenVersions.set(token.tokenId, token.version);
        nativeByChain.set(token.chain, true);
        continue;
      }
      if (token.normalizedContractAddress === undefined) continue;
      const previouslyExcluded = state.excludedTokens.has(token.tokenId);
      const previousVersion = this.#tokenVersions.get(token.tokenId);
      const needsVerification =
        previousVersion === undefined ||
        previousVersion !== token.version ||
        previouslyExcluded;
      if (needsVerification) {
        const reason = await this.#verifyTokenDecimals(state, token, snapshot.revision);
        if (reason !== undefined) {
          const excluded =
            excludedByChain.get(token.chain) ?? new Map<string, string>();
          excluded.set(token.tokenId, reason);
          excludedByChain.set(token.chain, excluded);
          this.#tokenVersions.set(token.tokenId, token.version);
          continue;
        }
        if (previouslyExcluded) {
          this.#logger.info(
            { chainId: token.chain, tokenId: token.tokenId },
            "Previously excluded token re-verified; rejoining watchlist",
          );
        }
      }
      this.#tokenVersions.set(token.tokenId, token.version);
      const contracts = contractsByChain.get(token.chain) ?? [];
      contracts.push(token.normalizedContractAddress.toLowerCase());
      contractsByChain.set(token.chain, contracts);
    }

    for (const [chainId, state] of this.#chains) {
      if (!enabledChainIds.has(chainId)) continue;
      state.contracts = contractsByChain.get(chainId) ?? [];
      state.native = nativeByChain.get(chainId) === true;
      state.recipients = recipientsByChain.get(chainId) ?? new Set<string>();
      state.excludedTokens = excludedByChain.get(chainId) ?? new Map();
    }
    this.#enabledChainCount = snapshot.chains.length;
    this.#registryRevision = snapshot.revision;
  }

  /**
   * Run the decimal guard for a token. Returns undefined when the token is
   * watchable; otherwise the exclusion reason after alerting and recording an
   * append-only audit entry (the registry itself is never mutated).
   */
  async #verifyTokenDecimals(
    state: ChainWatchState,
    token: RegistrySnapshot["tokens"][number],
    registryRevision: string,
  ): Promise<string | undefined> {
    // The caller guards native tokens and missing contracts; keep the defense
    // so a malformed record degrades readably rather than throwing.
    if (token.normalizedContractAddress === undefined) {
      return "metadata_missing";
    }
    let outcome: DecimalGuardOutcome;
    try {
      outcome = await state.runtime.decimalVerifier.verifyDecimals(
        token.normalizedContractAddress,
        token.decimals,
      );
    } catch (error: unknown) {
      this.#logger.error(
        { err: error, chainId: token.chain, tokenId: token.tokenId },
        "Decimal guard failed unexpectedly; excluding token",
      );
      outcome = { verified: false, reason: "provider_unavailable" };
    }
    if (outcome.verified) return undefined;

    const alreadyExcluded = state.excludedTokens.has(token.tokenId);
    this.#logger.error(
      {
        chainId: token.chain,
        tokenId: token.tokenId,
        contractAddress: token.normalizedContractAddress,
        expectedDecimals: token.decimals,
        reason: outcome.reason,
      },
      "Token excluded from watchlist by decimal guard",
    );
    if (!alreadyExcluded) {
      try {
        await appendAuditEntry(this.#connection, {
          scope: "platform",
          entityType: "Token",
          entityId: token.tokenId,
          action: "watcher.token_excluded",
          actorType: "system",
          actorId: "watcher",
          metadata: {
            chain: token.chain,
            contractAddress: token.normalizedContractAddress,
            expectedDecimals: token.decimals,
            reason: outcome.reason,
            registryRevision,
          },
        });
      } catch (error: unknown) {
        // Exclusion always takes effect; alert when the audit trail cannot keep up.
        this.#logger.error(
          { err: error, tokenId: token.tokenId },
          "Failed to record decimal-guard exclusion in audit log",
        );
      }
    }
    return outcome.reason;
  }

  #startChainLoop(state: ChainWatchState): void {
    if (state.loop !== undefined || state.halted || state.retired) return;
    const logger = this.#logger.child({ chainId: state.runtime.chainId });
    state.loop = (async () => {
      while (!this.#stopping && !state.halted && !state.retired) {
        let progressed = false;
        try {
          progressed = await this.#processNextBatch(state, logger);
        } catch (error: unknown) {
          if (error instanceof ChainDiscontinuityError) {
            const resolution =
              this.#reorgResolver === undefined
                ? "unresolvable"
                : await this.#resolveDiscontinuity(state, logger).catch(
                    (resolutionError: unknown) => {
                      logger.error(
                        { err: resolutionError },
                        "Reorg resolution crashed; halting chain",
                      );
                      return "unresolvable" as const;
                    },
                  );
            if (resolution === "resolved") {
              logger.warn(
                { err: error },
                "Parent-hash discontinuity resolved; replaying from the rewound cursor",
              );
              continue;
            }
            state.halted = true;
            logger.error(
              { err: error },
              "Chain halted at block parent-hash discontinuity; cursor left before the break for operator resolution",
            );
            return;
          }
          logger.warn(
            { err: error },
            "Watcher batch failed; retrying after poll interval",
          );
        }
        // `#stopping` ends the loop at the while condition; no extra check here.
        if (!progressed) {
          await sleep(this.#config.pollIntervalMs, () => this.#stopping);
        }
      }
    })();
  }

  async #resolveDiscontinuity(
    state: ChainWatchState,
    logger: Logger,
  ): Promise<"resolved" | "unresolvable"> {
    if (this.#reorgResolver === undefined) return "unresolvable";
    const runtime = state.runtime;
    logger.warn(
      { chainId: runtime.chainId },
      "Parent-hash discontinuity detected; attempting bounded reorg resolution",
    );
    return this.#reorgResolver.resolve({
      chainId: runtime.chainId,
      observation: runtime.observation,
      corroborator: runtime.corroborator,
      cursorStorage: runtime.cursorStorage,
    });
  }

  async #stopChain(state: ChainWatchState): Promise<void> {
    state.retired = true;
    if (state.loop !== undefined) {
      await state.loop;
      state.loop = undefined;
    }
    await state.runtime.adapter.stop();
  }

  /**
   * Process one cursor batch for a chain. Returns true when the loop should
   * immediately continue (catch-up), false when it should sleep one poll
   * interval. The cursor advances only after every relevant event in the range
   * has been acknowledged by the ingestion endpoint.
   */
  async #processNextBatch(state: ChainWatchState, logger: Logger): Promise<boolean> {
    if (this.#registryRevision === undefined) return false;
    const runtime = state.runtime;

    let cursor = await runtime.cursorStorage.read();
    if (cursor === undefined) {
      const head = await runtime.observation.getCurrentBlock();
      const anchorNumber = Math.max(0, head - this.#config.initialLookbackBlocks);
      const anchor = await runtime.observation.getBlockHeader(anchorNumber);
      const corroboration = await runtime.corroborator.corroborateBlockHeader(anchor);
      if (corroboration !== "agreeing") {
        logger.warn(
          { anchorNumber, corroboration },
          "Cursor bootstrap deferred: anchor block not corroborated by an independent provider",
        );
        return false;
      }
      cursor = await runtime.cursorStorage.bootstrap(anchor);
    }

    const head = await runtime.observation.getCurrentBlock();
    const fromBlock = cursor.lastProcessedBlock + 1;
    if (fromBlock > head) return false;
    const toBlock = Math.min(head, cursor.lastProcessedBlock + this.#config.batchSize);

    const headers: ObservedBlockHeader[] = [];
    let expectedParentHash = cursor.lastProcessedBlockHash;
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      const header = await runtime.observation.getBlockHeader(blockNumber);
      if (header.blockNumber !== blockNumber) {
        throw new Error(
          `Provider returned block ${header.blockNumber} when asked for ${blockNumber}`,
        );
      }
      if (header.parentHash !== expectedParentHash) {
        throw new ChainDiscontinuityError(
          `Chain ${runtime.chainId}: block ${blockNumber} parent hash does not match the previously observed hash`,
        );
      }
      headers.push(header);
      expectedParentHash = header.blockHash;
    }

    for (const header of headers) {
      const corroboration = await runtime.corroborator.corroborateBlockHeader(header);
      if (corroboration !== "agreeing") {
        logger.error(
          { blockNumber: header.blockNumber, corroboration },
          "Block header corroboration failed; batch discarded and cursor not advanced",
        );
        return false;
      }
    }

    if (state.contracts.length > 0) {
      const logs = await runtime.observation.getLogs({
        fromBlock,
        toBlock,
        contractAddresses: state.contracts,
        transferTopic: this.#logDecoder.transferTopic,
      });
      const ordered = [...logs].sort(
        (left, right) =>
          left.blockNumber - right.blockNumber || left.logIndex - right.logIndex,
      );
      for (const entry of ordered) {
        if (this.#stopping) return false;
        const decoded = this.#logDecoder.decodeTransfer(entry);
        if (decoded === undefined) continue;
        if (!state.recipients.has(decoded.toAddress.toLowerCase())) continue;
        await this.#ingestionClient.submitEvent({
          chain: runtime.chainId,
          assetType: "erc20",
          contractAddress: entry.contractAddress,
          transactionHash: entry.transactionHash,
          logIndex: entry.logIndex,
          blockNumber: entry.blockNumber,
          blockHash: entry.blockHash,
          fromAddress: decoded.fromAddress,
          toAddress: decoded.toAddress,
          amount: decoded.amount,
          rawEvent: entry.raw,
        });
      }
    }

    // Native value-transfer scan (ADR 0018): only chains with an enabled native
    // token fetch full blocks. A candidate is a top-level transaction to a watched
    // recipient carrying a positive value; the verbatim transaction is the rawEvent.
    if (state.native && state.recipients.size > 0) {
      for (const header of headers) {
        const transactions = await runtime.observation.getBlockTransactions(
          header.blockNumber,
        );
        for (const tx of transactions) {
          if (this.#stopping) return false;
          if (tx.to === undefined || tx.to === null || tx.value <= 0n) continue;
          if (!state.recipients.has(tx.to.toLowerCase())) continue;
          await this.#ingestionClient.submitEvent({
            chain: runtime.chainId,
            assetType: "native",
            transactionHash: tx.hash,
            blockNumber: header.blockNumber,
            blockHash: header.blockHash,
            fromAddress: tx.from,
            toAddress: tx.to,
            amount: tx.value.toString(10),
            rawEvent: {
              hash: tx.hash,
              from: tx.from,
              to: tx.to,
              value: tx.value.toString(),
              blockNumber: header.blockNumber,
              blockHash: header.blockHash,
            },
          });
        }
      }
    }

    const lastHeader = headers[headers.length - 1];
    if (lastHeader === undefined) return false;
    try {
      await runtime.cursorStorage.advance({
        expectedVersion: cursor.version,
        lastProcessedBlock: toBlock,
        lastProcessedBlockHash: lastHeader.blockHash,
        headers,
      });
    } catch (error: unknown) {
      if (error instanceof ChainCursorConflictError) {
        logger.debug("Cursor advanced by another watcher instance; rereading cursor");
        return true;
      }
      throw error;
    }
    logger.debug({ fromBlock, toBlock }, "Watcher batch processed and cursor advanced");
    return true;
  }
}
