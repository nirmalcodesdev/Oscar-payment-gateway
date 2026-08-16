/**
 * Chain-neutral deposit observation contracts (ADR 0009).
 *
 * The domain layer defines only chain-agnostic shapes. EVM/viem specifics are
 * confined to the infrastructure implementation; future non-EVM adapters must
 * not inherit block-number-only or EVM-only assumptions from shared code.
 */

export interface OnChainDepositEvent {
  /** Registry chain identity (`Chain.chainId`), never a numeric network id. */
  readonly chain: string;
  readonly contractAddress: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  /** Base-unit integer string; never a floating point value. */
  readonly amount: string;
  /** Verbatim provider log payload, retained for replay and audit. */
  readonly rawEvent: Readonly<Record<string, unknown>>;
}

export interface ChainAdapter {
  readonly chainId: string;
  /** Verify provider configuration and chain identity before any watching. */
  init(): Promise<void>;
  getCurrentBlock(): Promise<number>;
  getConfirmations(txHash: string): Promise<number>;
  isCanonical(txHash: string, expectedBlockNumber: number): Promise<boolean>;
  watchDeposits(callback: (event: OnChainDepositEvent) => Promise<void>): void;
  /** Halt timers and in-flight work deterministically for graceful shutdown. */
  stop(): Promise<void>;
}

export interface ObservedBlockHeader {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly parentHash: string;
}

export interface ChainLogFilter {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly contractAddresses: readonly string[];
  readonly transferTopic: string;
}

export interface ChainLogEntry {
  readonly contractAddress: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly topics: readonly string[];
  readonly data: string;
  /** Verbatim provider log payload. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Read-only observation port used by the durable watcher pipeline. */
export interface ChainObservationPort {
  getCurrentBlock(): Promise<number>;
  getBlockHeader(blockNumber: number): Promise<ObservedBlockHeader>;
  getLogs(filter: ChainLogFilter): Promise<readonly ChainLogEntry[]>;
}

/** Result of a corroborated recipient balance delta read (ADR 0010). */
export interface BalanceDeltaRead {
  readonly status: "agreeing" | "disagreement" | "unavailable";
  /** Present only when independent providers agree. */
  readonly delta?: string;
}

/**
 * Balance-delta verification port for fee-on-transfer and rebasing tokens.
 * Implementations must read the recipient's balance at the block before the
 * transfer and at the transfer block through at least two independent
 * providers and report whether they agree.
 */
export interface BalanceDeltaReader {
  readDelta(input: {
    readonly chain: string;
    readonly contractAddress: string;
    readonly holder: string;
    readonly blockNumber: number;
  }): Promise<BalanceDeltaRead>;
}

/** Result of cross-checking a block header against an independent provider (ADR 0009). */
export type BlockHeaderCorroboration = "agreeing" | "disagreement" | "unavailable";

/**
 * Cross-check port for observed block headers. Implementations must read the
 * same height through a provider independent of the one that produced the
 * header and report whether the block hashes agree.
 */
export interface BlockHeaderCorroborator {
  corroborateBlockHeader(
    header: ObservedBlockHeader,
  ): Promise<BlockHeaderCorroboration>;
}

/** Persisted per-chain sync position. No in-memory position is authoritative. */
export interface ChainCursorState {
  readonly lastProcessedBlock: number;
  readonly lastProcessedBlockHash: string;
  readonly version: number;
}

/**
 * Durable cursor storage owned by the watcher pipeline (ADR 0009). The
 * implementation must advance the cursor only inside the same transaction that
 * records the observed block metadata, conditional on the stored version.
 */
export interface ChainCursorStorage {
  /** Undefined until a cursor has been bootstrapped for the chain. */
  read(): Promise<ChainCursorState | undefined>;
  /**
   * Ensure a cursor exists anchored at the given header, creating it together
   * with the anchor's observed block record when absent. Returns the current
   * state, which may have been created by a concurrent watcher instance.
   */
  bootstrap(anchor: ObservedBlockHeader): Promise<ChainCursorState>;
  advance(input: {
    readonly expectedVersion: number;
    readonly lastProcessedBlock: number;
    readonly lastProcessedBlockHash: string;
    readonly headers: readonly ObservedBlockHeader[];
  }): Promise<void>;
  /**
   * Rewind the cursor to a resolved fork point after reorg resolution
   * (ADR 0012). Conditional on the stored version so only one watcher
   * instance's resolution wins; returns false when another instance moved
   * the cursor first.
   */
  rewind(input: {
    readonly expectedVersion: number;
    readonly lastProcessedBlock: number;
    readonly lastProcessedBlockHash: string;
  }): Promise<boolean>;
}

/**
 * An observed block's parent hash does not match the previously recorded hash
 * for the parent height. The chain must halt with the cursor left before the
 * discontinuity; fork resolution belongs to Phase 07.
 */
export class ChainDiscontinuityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChainDiscontinuityError";
  }
}

/** Another watcher instance advanced the cursor first; retry the range. */
export class ChainCursorConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChainCursorConflictError";
  }
}
