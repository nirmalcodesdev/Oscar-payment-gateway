import type { ClientSession, Connection } from "mongoose";

import type {
  ChainCursorState,
  ChainCursorStorage,
  ObservedBlockHeader,
} from "../../domain/chain/chain-adapter.js";
import {
  ChainCursorConflictError,
  ChainDiscontinuityError,
} from "../../domain/chain/chain-adapter.js";
import { registerPersistenceModels } from "../mongodb/models.js";
import { withRequiredTransaction } from "../mongodb/transactions.js";

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === 11_000
  );
}

/**
 * MongoDB-backed durable cursor (ADR 0009). Advancement happens only inside
 * the single transaction that also records the range's observed blocks, and
 * the update is conditional on the stored version so overlapping watcher
 * instances cannot double-advance.
 *
 * Observed blocks are classified against persistence before the transaction
 * opens (new / identical-duplicate / fork-conflicting), because a duplicate-key
 * write aborts a MongoDB transaction server-side and no recovery can run on
 * the aborted session. Duplicate delivery of an already-committed batch is
 * therefore benign and the range is replayed idempotently; a conflicting hash
 * at any height halts the chain with `ChainDiscontinuityError`.
 */
export class MongoChainCursorStorage implements ChainCursorStorage {
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #connection: Connection;
  readonly #chain: string;

  public constructor(connection: Connection, chain: string) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#chain = chain;
  }

  public async read(): Promise<ChainCursorState | undefined> {
    const cursor = await this.#models.ChainCursor.findOne({
      chain: this.#chain,
    }).lean();
    if (cursor === null) return undefined;
    return {
      lastProcessedBlock: cursor.lastProcessedBlock,
      lastProcessedBlockHash: cursor.lastProcessedBlockHash,
      version: cursor.version,
    };
  }

  public async bootstrap(anchor: ObservedBlockHeader): Promise<ChainCursorState> {
    try {
      await withRequiredTransaction(this.#connection, async (session) => {
        await this.#models.ChainCursor.create(
          [
            {
              chain: this.#chain,
              lastProcessedBlock: anchor.blockNumber,
              lastProcessedBlockHash: anchor.blockHash,
              version: 0,
              updatedAt: new Date(),
            },
          ],
          { session },
        );
        await this.#insertObservedBlocks([anchor], session);
      });
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) throw error;
      // Another instance bootstrapped concurrently; their state stands.
    }
    const current = await this.read();
    if (current === undefined) {
      throw new Error(`Chain cursor for ${this.#chain} vanished during bootstrap`);
    }
    return current;
  }

  public async advance(input: {
    readonly expectedVersion: number;
    readonly lastProcessedBlock: number;
    readonly lastProcessedBlockHash: string;
    readonly headers: readonly ObservedBlockHeader[];
  }): Promise<void> {
    // Observed blocks are classified against persistence BEFORE opening the
    // transaction: a duplicate-key write aborts the transaction server-side
    // (subsequent commands on the session fail with code 251), so fork
    // detection and benign-replay recognition cannot run inside it.
    const newHeaders = await this.#classifyObservedBlocks(input.headers);
    await withRequiredTransaction(this.#connection, async (session) => {
      await this.#insertObservedBlocks(newHeaders, session);
      const updated = await this.#models.ChainCursor.updateOne(
        { chain: this.#chain, version: input.expectedVersion },
        {
          $set: {
            lastProcessedBlock: input.lastProcessedBlock,
            lastProcessedBlockHash: input.lastProcessedBlockHash,
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw new ChainCursorConflictError(
          `Chain cursor for ${this.#chain} changed concurrently (expected version ${input.expectedVersion})`,
        );
      }
    });
  }

  /**
   * Rewind to a resolved fork point (ADR 0012). The observed block record for
   * the fork point already exists from the original pass; only the cursor
   * position and hash move, conditional on the stored version.
   */
  public async rewind(input: {
    readonly expectedVersion: number;
    readonly lastProcessedBlock: number;
    readonly lastProcessedBlockHash: string;
  }): Promise<boolean> {
    return withRequiredTransaction(this.#connection, async (session) => {
      const updated = await this.#models.ChainCursor.updateOne(
        { chain: this.#chain, version: input.expectedVersion },
        {
          $set: {
            lastProcessedBlock: input.lastProcessedBlock,
            lastProcessedBlockHash: input.lastProcessedBlockHash,
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      return updated.modifiedCount === 1;
    });
  }

  /**
   * Split headers into genuinely new blocks and ones already persisted. A
   * canonical height already observed with the same hash is a benign
   * duplicate delivery of a previously committed batch; the same height with
   * a different hash is a fork at that height, so the chain must halt before
   * building on inconsistent history. Records already flagged non-canonical
   * by reorg resolution never conflict: replacement blocks legitimately carry
   * different hashes at those heights.
   */
  async #classifyObservedBlocks(
    headers: readonly ObservedBlockHeader[],
  ): Promise<readonly ObservedBlockHeader[]> {
    if (headers.length === 0) return [];
    const existing = await this.#models.ObservedBlock.find({
      chain: this.#chain,
      blockNumber: { $in: headers.map((header) => header.blockNumber) },
      canonical: true,
    }).lean();
    const newHeaders: ObservedBlockHeader[] = [];
    for (const header of headers) {
      const recorded = existing.find(
        (block) => block.blockNumber === header.blockNumber,
      );
      if (recorded === undefined) {
        newHeaders.push(header);
        continue;
      }
      if (recorded.blockHash !== header.blockHash) {
        throw new ChainDiscontinuityError(
          `Conflicting block hash recorded for chain ${this.#chain} at block ${header.blockNumber}`,
        );
      }
    }
    return newHeaders;
  }

  /**
   * Insert observed blocks that were not already persisted. This runs inside
   * the cursor-advance transaction (ADR 0009) and deliberately does not catch
   * duplicate-key errors: if another instance commits the same block first,
   * the write fails and the transaction aborts rather than racing silently.
   */
  async #insertObservedBlocks(
    headers: readonly ObservedBlockHeader[],
    session: ClientSession,
  ): Promise<void> {
    if (headers.length === 0) return;
    await this.#models.ObservedBlock.create(
      headers.map((header) => ({
        chain: this.#chain,
        blockNumber: header.blockNumber,
        blockHash: header.blockHash,
        parentHash: header.parentHash,
        canonical: true,
        observedAt: new Date(),
      })),
      // Ordered inserts stop at the first duplicate key so the transaction
      // aborts instead of racing another instance that committed first.
      { session, ordered: true },
    );
  }
}
