import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import type {
  BlockHeaderCorroboration,
  BlockHeaderCorroborator,
  ChainAdapter,
  ChainLogEntry,
  ChainLogFilter,
  ChainObservationPort,
  ObservedBlockHeader,
  OnChainDepositEvent,
} from "../../domain/chain/chain-adapter.js";
import {
  erc20TransferTopic,
  type EvmProviderClient,
  type EvmProviderClientFactory,
  type RpcProviderReference,
  viemProviderClientFactory,
} from "./evm-registry-verifier.js";

export interface EvmChainRecord {
  readonly chainId: string;
  readonly networkChainId: number;
  readonly rpcProviders: readonly RpcProviderReference[];
}

export class EvmChainAdapterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EvmChainAdapterError";
  }
}

const maximumConsecutiveFailures = 2;
const addressTopicPattern = /^0x000000(00){9}[0-9a-fA-F]{40}$/;
const wordPattern = /^0x[0-9a-fA-F]{64}$/;

interface ProviderState {
  readonly reference: RpcProviderReference;
  readonly client: EvmProviderClient;
  consecutiveFailures: number;
  healthy: boolean;
}

export interface ResolvedProviderClient {
  readonly reference: RpcProviderReference;
  readonly client: EvmProviderClient;
}

/**
 * Resolve a chain's provider references into clients using the Phase 04
 * rules: catalog membership, operator match, distinct providers, and at least
 * two distinct operators. Throws `EvmChainAdapterError` on any violation.
 */
export function resolveChainProviderClients(options: {
  readonly chainId: string;
  readonly rpcProviders: readonly RpcProviderReference[];
  readonly config: RuntimeConfig["rpc"];
  readonly factory?: EvmProviderClientFactory;
}): ResolvedProviderClient[] {
  const factory = options.factory ?? viemProviderClientFactory;
  const providerIds = new Set<string>();
  const operatorIds = new Set<string>();
  const resolved = options.rpcProviders.map((reference) => {
    const configured = options.config.providers[reference.providerId];
    if (
      configured === undefined ||
      configured.operatorId !== reference.operatorId ||
      providerIds.has(reference.providerId)
    ) {
      throw new EvmChainAdapterError(
        `Provider ${reference.providerId} is not configured for chain ${options.chainId}`,
      );
    }
    providerIds.add(reference.providerId);
    operatorIds.add(reference.operatorId);
    return {
      reference,
      client: factory.create(
        reference.providerId,
        configured.url,
        options.config.requestTimeoutMs,
      ),
    };
  });
  if (resolved.length < 2 || operatorIds.size < 2) {
    throw new EvmChainAdapterError(
      `Chain ${options.chainId} requires at least two providers from distinct operators`,
    );
  }
  return resolved;
}

/**
 * Decode a canonical ERC-20 `Transfer` log entry into normalized deposit
 * fields. Returns undefined for any shape that is not a valid two-topic
 * Transfer log with a 32-byte data word.
 */
export function decodeTransferLog(entry: ChainLogEntry):
  | {
      readonly fromAddress: string;
      readonly toAddress: string;
      readonly amount: string;
    }
  | undefined {
  const [topic0, topic1, topic2] = entry.topics;
  if (
    entry.topics.length !== 3 ||
    typeof topic0 !== "string" ||
    typeof topic1 !== "string" ||
    typeof topic2 !== "string"
  ) {
    return undefined;
  }
  if (
    topic0.toLowerCase() !== erc20TransferTopic ||
    !addressTopicPattern.test(topic1) ||
    !addressTopicPattern.test(topic2) ||
    !wordPattern.test(entry.data) ||
    entry.data.length !== 66
  ) {
    return undefined;
  }
  return {
    fromAddress: `0x${topic1.slice(26)}`,
    toAddress: `0x${topic2.slice(26)}`,
    amount: BigInt(entry.data).toString(10),
  };
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

export interface EvmChainAdapterOptions {
  readonly chain: EvmChainRecord;
  readonly config: RuntimeConfig["rpc"];
  readonly logger: Logger;
  readonly factory?: EvmProviderClientFactory;
  readonly pollIntervalMs?: number;
  readonly watchBatchSize?: number;
}

/**
 * EVM implementation of the chain-neutral adapter contract (ADR 0009),
 * composed on the shared Phase 04 provider client (ADR 0003). One provider is
 * active at a time; consecutive failures fail over in configured order, and a
 * provider rejoins the pool only after a successful verified call.
 */
export class EvmChainAdapter
  implements ChainAdapter, ChainObservationPort, BlockHeaderCorroborator
{
  public readonly chainId: string;
  readonly #networkChainId: number;
  readonly #providers: ProviderState[];
  readonly #logger: Logger;
  readonly #pollIntervalMs: number;
  readonly #watchBatchSize: number;
  #activeIndex = 0;
  #failoverCount = 0;
  #stopping = false;
  #watchLoop: Promise<void> | undefined;
  #watchContracts: readonly string[] = [];

  public constructor(options: EvmChainAdapterOptions) {
    this.chainId = options.chain.chainId;
    this.#networkChainId = options.chain.networkChainId;
    this.#logger = options.logger.child({
      component: "evm-chain-adapter",
      chain: options.chain.chainId,
    });
    this.#pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.#watchBatchSize = options.watchBatchSize ?? 10;

    const resolved = resolveChainProviderClients({
      chainId: options.chain.chainId,
      rpcProviders: options.chain.rpcProviders,
      config: options.config,
      ...(options.factory === undefined ? {} : { factory: options.factory }),
    });
    this.#providers = resolved.map((entry) => ({
      ...entry,
      consecutiveFailures: 0,
      healthy: true,
    }));
  }

  /** Count of provider failovers since construction (v1 metrics surface). */
  public get failoverCount(): number {
    return this.#failoverCount;
  }

  /** The chain's resolved provider clients (shared by the decimal guard). */
  public providers(): readonly ResolvedProviderClient[] {
    return this.#providers;
  }

  /** Verify the numeric chain identity through all providers (fail closed). */
  public async init(): Promise<void> {
    let chainIds: number[];
    try {
      chainIds = await Promise.all(
        this.#providers.map((provider) => provider.client.getChainId()),
      );
    } catch {
      throw new EvmChainAdapterError(
        `Chain ${this.chainId}: provider unavailable during chain identity verification`,
      );
    }
    if (!chainIds.every((value) => value === chainIds[0])) {
      throw new EvmChainAdapterError(
        `Chain ${this.chainId}: providers disagree on chain identity`,
      );
    }
    if (chainIds[0] !== this.#networkChainId) {
      throw new EvmChainAdapterError(
        `Chain ${this.chainId}: provider reported chain id ${chainIds[0]}, expected ${this.#networkChainId}`,
      );
    }
  }

  public async getCurrentBlock(): Promise<number> {
    const blockNumber = await this.#withFailover((client) => client.getBlockNumber());
    return Number(blockNumber);
  }

  public async getConfirmations(txHash: string): Promise<number> {
    const receipt = await this.#withFailover((client) =>
      client.getTransactionReceipt(txHash as `0x${string}`),
    );
    if (receipt === undefined) return 0;
    const current = await this.getCurrentBlock();
    if (receipt.blockNumber > current) return 0;
    return current - receipt.blockNumber + 1;
  }

  public async isCanonical(
    txHash: string,
    expectedBlockNumber: number,
  ): Promise<boolean> {
    const receipt = await this.#withFailover((client) =>
      client.getTransactionReceipt(txHash as `0x${string}`),
    );
    if (receipt === undefined || receipt.blockNumber !== expectedBlockNumber) {
      return false;
    }
    const header = await this.getBlockHeader(expectedBlockNumber);
    return header.blockHash === receipt.blockHash;
  }

  public async getBlockHeader(blockNumber: number): Promise<ObservedBlockHeader> {
    return this.#withFailover((client) => client.getBlockHeader(BigInt(blockNumber)));
  }

  public async getLogs(filter: ChainLogFilter): Promise<readonly ChainLogEntry[]> {
    return this.#withFailover((client) => client.getLogs(filter));
  }

  /** Native value-transfer candidates for a block (ADR 0018). */
  public async getBlockTransactions(blockNumber: number): Promise<
    readonly {
      readonly hash: string;
      readonly from: string;
      readonly to?: string | null;
      readonly value: bigint;
    }[]
  > {
    return this.#withFailover((client) =>
      client.getBlockTransactions(BigInt(blockNumber)),
    );
  }

  /**
   * Cross-check an observed header through a provider independent of the
   * active one (ADR 0009). Disagreement is explicit; if no independent
   * provider can answer, the result is unavailable and callers fail closed.
   */
  public async corroborateBlockHeader(
    header: ObservedBlockHeader,
  ): Promise<BlockHeaderCorroboration> {
    const independents = this.#providers.filter(
      (provider, index) => index !== this.#activeIndex && provider.healthy,
    );
    if (independents.length === 0) return "unavailable";
    let sawDisagreement = false;
    for (const provider of independents) {
      try {
        const independent = await provider.client.getBlockHeader(
          BigInt(header.blockNumber),
        );
        if (independent.blockHash === header.blockHash) return "agreeing";
        sawDisagreement = true;
      } catch {
        // This independent provider could not answer; try the next one.
      }
    }
    return sawDisagreement ? "disagreement" : "unavailable";
  }

  /** Set the contract addresses the `watchDeposits` loop filters on. */
  public setWatchContracts(contractAddresses: readonly string[]): void {
    this.#watchContracts = [...contractAddresses];
  }

  /**
   * Bounded poll-and-catch-up deposit stream (ADR 0009). Observation starts at
   * the current head; the durable watcher pipeline drives its own cursor-based
   * loop through the observation port instead.
   */
  public watchDeposits(callback: (event: OnChainDepositEvent) => Promise<void>): void {
    if (this.#watchLoop !== undefined) return;
    this.#stopping = false;
    this.#watchLoop = this.#runWatchLoop(callback);
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#watchLoop !== undefined) {
      await this.#watchLoop;
      this.#watchLoop = undefined;
    }
  }

  async #runWatchLoop(
    callback: (event: OnChainDepositEvent) => Promise<void>,
  ): Promise<void> {
    let nextBlock: number | undefined;
    while (!this.#stopping) {
      let caughtUp = false;
      try {
        const head = await this.getCurrentBlock();
        const from = nextBlock ?? head;
        if (from > head) {
          caughtUp = true;
        } else {
          const to = Math.min(head, from + this.#watchBatchSize - 1);
          await this.#deliverRange(from, to, callback);
          nextBlock = to + 1;
        }
      } catch (error: unknown) {
        this.#logger.warn({ err: error }, "Deposit watch poll failed");
      }
      // `#stopping` ends the loop at the while condition; no extra check here.
      if (caughtUp) {
        await sleep(this.#pollIntervalMs, () => this.#stopping);
      }
    }
  }

  async #deliverRange(
    fromBlock: number,
    toBlock: number,
    callback: (event: OnChainDepositEvent) => Promise<void>,
  ): Promise<void> {
    if (this.#watchContracts.length === 0) return;
    const logs = await this.getLogs({
      fromBlock,
      toBlock,
      contractAddresses: this.#watchContracts,
      transferTopic: erc20TransferTopic,
    });
    for (const entry of logs) {
      if (this.#stopping) return;
      const decoded = decodeTransferLog(entry);
      if (decoded === undefined) continue;
      await callback({
        chain: this.chainId,
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

  /**
   * Run an operation against the active provider, failing over in configured
   * order on consecutive failures. Unhealthy providers are probed with the
   * same operation and rejoin the pool only after a successful call.
   */
  async #withFailover<T>(
    operation: (client: EvmProviderClient) => Promise<T>,
  ): Promise<T> {
    this.#rehabilitateUnhealthy();
    let lastError: unknown;
    let attempts = 0;
    while (attempts < this.#providers.length) {
      attempts += 1;
      const provider = this.#activeProvider();
      if (provider === undefined) {
        this.#logger.error(
          { chain: this.chainId, failoverCount: this.#failoverCount },
          "All chain providers are unavailable",
        );
        break;
      }
      try {
        const result = await operation(provider.client);
        provider.consecutiveFailures = 0;
        return result;
      } catch (error: unknown) {
        lastError = error;
        provider.consecutiveFailures += 1;
        if (provider.consecutiveFailures >= maximumConsecutiveFailures) {
          provider.healthy = false;
          this.#failoverCount += 1;
          this.#logger.warn(
            {
              providerId: provider.reference.providerId,
              consecutiveFailures: provider.consecutiveFailures,
              failoverCount: this.#failoverCount,
            },
            "Marking chain provider unhealthy and failing over",
          );
          this.#activeIndex = this.#nextHealthyIndex();
        }
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new EvmChainAdapterError(`Chain ${this.chainId}: no provider available`);
  }

  #activeProvider(): ProviderState | undefined {
    const active = this.#providers[this.#activeIndex];
    return active?.healthy === true ? active : undefined;
  }

  #nextHealthyIndex(): number {
    for (let offset = 1; offset <= this.#providers.length; offset += 1) {
      const index = (this.#activeIndex + offset) % this.#providers.length;
      if (this.#providers[index]?.healthy === true) return index;
    }
    return this.#activeIndex;
  }

  /**
   * Probe unhealthy providers in configured order so recovery requires a
   * successful verified call, never a timer alone.
   */
  #rehabilitateUnhealthy(): void {
    for (const provider of this.#providers) {
      if (provider.healthy) continue;
      void provider.client
        .getChainId()
        .then((chainId) => {
          if (chainId !== this.#networkChainId) return;
          provider.healthy = true;
          provider.consecutiveFailures = 0;
          this.#logger.info(
            { providerId: provider.reference.providerId },
            "Chain provider recovered",
          );
        })
        .catch(() => {
          // Still unavailable; the next cycle probes again.
        });
    }
  }
}
