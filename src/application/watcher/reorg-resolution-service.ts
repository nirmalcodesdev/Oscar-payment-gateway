import { createHash, randomUUID } from "node:crypto";

import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import type {
  BlockHeaderCorroborator,
  ChainCursorStorage,
  ChainObservationPort,
  ObservedBlockHeader,
} from "../../domain/chain/chain-adapter.js";
import { appendAuditEntryInTransaction } from "../../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";
import { withRequiredTransaction } from "../../infrastructure/mongodb/transactions.js";

/** Per-chain observation pieces the resolver needs from the watcher runtime. */
export interface ReorgResolutionRuntime {
  readonly chainId: string;
  readonly observation: ChainObservationPort;
  readonly corroborator: BlockHeaderCorroborator;
  readonly cursorStorage: ChainCursorStorage;
}

export type ReorgResolutionOutcome = "resolved" | "unresolvable";

interface EventLike {
  readonly eventId: string;
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly amount: string;
  readonly matchedPaymentId?: string;
}

interface PaymentLike {
  readonly paymentId: string;
  readonly merchantId: string;
  readonly status: string;
  readonly version: number;
  readonly amount: string;
}

/**
 * Reorg resolution (ADR 0012). Locates the fork point by walking stored
 * observed blocks backward against corroborated live headers, marks orphaned
 * history non-canonical (never deletes), writes the `ReorgRecord`, resolves
 * payment effects (including deep-reorg finality incidents with automation
 * holds), rewinds the cursor to the fork point, and lets the watcher replay
 * the replacement blocks through the normal ingestion pipeline.
 *
 * Unresolvable situations (no corroborated agreement, scan bound exceeded,
 * fork below the anchored history) leave the chain halted exactly as the
 * Phase 06 behavior: cursor before the break, degraded readiness, operator
 * action required. Resolution never guesses.
 */
export class ReorgResolutionService {
  readonly #connection: Connection;
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #config: RuntimeConfig["processing"];
  readonly #logger: Logger;

  public constructor(
    connection: Connection,
    config: RuntimeConfig["processing"],
    logger: Logger,
  ) {
    this.#connection = connection;
    this.#models = registerPersistenceModels(connection);
    this.#config = config;
    this.#logger = logger.child({ component: "reorg-resolution" });
  }

  public async resolve(
    runtime: ReorgResolutionRuntime,
  ): Promise<ReorgResolutionOutcome> {
    const logger = this.#logger.child({ chainId: runtime.chainId });
    const cursor = await runtime.cursorStorage.read();
    if (cursor === undefined) return "unresolvable";

    // Walk down from the last processed block to the fork point: the highest
    // height whose stored canonical hash agrees with the corroborated live
    // chain. The scan is bounded so a deep or pathological fork cannot loop.
    let forkPoint: ObservedBlockHeader | undefined;
    let scanned = 0;
    for (
      let height = cursor.lastProcessedBlock;
      height >= 0 && scanned < this.#config.reorgMaxScanBlocks;
      height -= 1, scanned += 1
    ) {
      const stored = await this.#models.ObservedBlock.findOne({
        chain: runtime.chainId,
        blockNumber: height,
        canonical: true,
      }).lean();
      if (stored === null) {
        // Below our observed history: the fork predates the anchor. Halting
        // is the only safe answer.
        break;
      }
      const live = await runtime.observation.getBlockHeader(height);
      if (live.blockNumber !== height) break;
      const corroboration = await runtime.corroborator.corroborateBlockHeader(live);
      if (corroboration !== "agreeing") {
        logger.warn(
          { height, corroboration },
          "Fork-point search could not corroborate the live header; halting chain",
        );
        return "unresolvable";
      }
      if (live.blockHash.toLowerCase() === stored.blockHash.toLowerCase()) {
        forkPoint = {
          blockNumber: height,
          blockHash: stored.blockHash,
          parentHash: stored.parentHash,
        };
        break;
      }
    }

    if (forkPoint === undefined) {
      logger.error(
        { from: cursor.lastProcessedBlock, scanned },
        "No fork point within the reorg scan bound; halting chain",
      );
      return "unresolvable";
    }

    if (forkPoint.blockNumber === cursor.lastProcessedBlock) {
      // Transient provider disagreement, not a real fork: the stored head is
      // still canonical. Resume from the cursor without rewriting anything.
      logger.info(
        { blockNumber: forkPoint.blockNumber },
        "Discontinuity resolved as transient; resuming from the stored cursor",
      );
      return "resolved";
    }

    const fromBlock = forkPoint.blockNumber + 1;
    const orphanedBlocks = await this.#models.ObservedBlock.find({
      chain: runtime.chainId,
      blockNumber: { $gt: forkPoint.blockNumber },
      canonical: true,
    })
      .sort({ blockNumber: -1 })
      .lean();
    if (orphanedBlocks.length === 0) {
      // Nothing observed above the fork point yet; safe to resume.
      return "resolved";
    }
    const toBlock = orphanedBlocks[0]?.blockNumber ?? fromBlock;

    // Affected events are captured before flagging so the ReorgRecord links
    // the exact orphaned history.
    const orphanedEvents = await this.#models.OnChainEvent.find({
      chain: runtime.chainId,
      blockNumber: { $gt: forkPoint.blockNumber },
      canonical: true,
    }).lean();
    const claimedPaymentIds = orphanedEvents
      .map((event) => (event as unknown as EventLike).matchedPaymentId)
      .filter((id): id is string => typeof id === "string");
    const affectedPaymentIds = [...new Set(claimedPaymentIds)];

    const reorgId = `reorg_${randomUUID()}`;
    await withRequiredTransaction(this.#connection, async (session) => {
      await this.#models.ObservedBlock.updateMany(
        {
          chain: runtime.chainId,
          blockNumber: { $gt: forkPoint.blockNumber },
          canonical: true,
        },
        { $set: { canonical: false } },
        { session },
      );
      await this.#models.OnChainEvent.updateMany(
        {
          chain: runtime.chainId,
          blockNumber: { $gt: forkPoint.blockNumber },
          canonical: true,
        },
        { $set: { canonical: false } },
        { session },
      );
      await this.#models.ReorgRecord.create(
        [
          {
            reorgId,
            chain: runtime.chainId,
            fromBlock,
            toBlock,
            detectedAt: new Date(),
            orphanedTxHashes: [
              ...new Set(
                orphanedEvents.map(
                  (event) => (event as unknown as EventLike).transactionHash,
                ),
              ),
            ],
            affectedPaymentIds,
          },
        ],
        { session },
      );
    });

    await this.#resolvePaymentEffects(
      affectedPaymentIds,
      reorgId,
      runtime.chainId,
      logger,
    );

    const rewound = await runtime.cursorStorage.rewind({
      expectedVersion: cursor.version,
      lastProcessedBlock: forkPoint.blockNumber,
      lastProcessedBlockHash: forkPoint.blockHash,
    });
    if (!rewound) {
      // Another watcher instance moved the cursor; its resolution stands.
      logger.info("Cursor rewind lost a concurrent race; the winner's state stands");
      return "resolved";
    }

    logger.warn(
      { reorgId, fromBlock, toBlock, affectedPaymentIds: affectedPaymentIds.length },
      "Reorg resolved: history preserved non-canonically, cursor rewound for replay",
    );
    return "resolved";
  }

  async #resolvePaymentEffects(
    paymentIds: readonly string[],
    reorgId: string,
    chainId: string,
    logger: Logger,
  ): Promise<void> {
    for (const paymentId of paymentIds) {
      const raw = await this.#models.Payment.findOne({ paymentId }).lean();
      if (raw === null) continue;
      const payment = raw as unknown as PaymentLike;

      if (payment.status === "confirmed") {
        // Finality-assumption violation (ADR 0012): terminal history is
        // preserved, automation is blocked, and an immutable incident trail
        // is created for an audited manual disposition.
        logger.error(
          { paymentId, reorgId, chainId },
          "p1_finality_incident: reorg orphaned events claimed by a confirmed payment",
        );
        await withRequiredTransaction(this.#connection, async (session) => {
          await this.#models.Payment.findOneAndUpdate(
            { paymentId, version: payment.version },
            {
              $set: { automationHold: true, automationHoldReorgId: reorgId },
              $inc: { version: 1 },
            },
            { session },
          );
          await appendAuditEntryInTransaction(
            this.#connection,
            {
              scope: `merchant_${payment.merchantId}`,
              entityType: "Payment",
              entityId: paymentId,
              action: "payment_finality_incident",
              actorType: "system",
              actorId: "watcher",
              before: { status: "confirmed", automationHold: false },
              after: { status: "confirmed", automationHold: true, reorgId },
              metadata: { reorgId, chainId, severity: "p1" },
            },
            session,
          );
        });
        await this.#annotate(
          "Payment",
          paymentId,
          "Deep-reorg finality incident: confirmed payment's events were orphaned; manual disposition required",
          payment.merchantId,
          reorgId,
        );
        continue;
      }

      if (payment.status === "pending") {
        // Recompute partial accumulation from surviving canonical claims.
        const claims = await this.#models.OnChainEvent.find({
          matchedPaymentId: paymentId,
          canonical: true,
        }).lean();
        const total = claims.reduce(
          (sum, claim) => sum + BigInt((claim as unknown as EventLike).amount),
          0n,
        );
        await this.#models.Payment.findOneAndUpdate(
          { paymentId, status: "pending", version: payment.version },
          {
            $set: {
              partialAmountReceived: total.toString(10),
              underpaymentFlag: total > 0n,
            },
            $inc: { version: 1 },
          },
        );
      }

      await this.#annotate(
        "Payment",
        paymentId,
        "Reorg orphaned claimed events; awaiting a canonical replacement until the grace deadline",
        payment.merchantId,
        reorgId,
      );
    }
  }

  async #annotate(
    entityType: "Payment",
    entityId: string,
    note: string,
    merchantId: string,
    reorgId: string,
  ): Promise<void> {
    const digest = createHash("sha256")
      .update(`${entityType}:${entityId}:reorg:${reorgId}`)
      .digest("hex");
    const annotationId = `ann_${digest.slice(0, 40)}`;
    try {
      await this.#models.ReconciliationAnnotation.create({
        annotationId,
        entityType,
        entityId,
        merchantId,
        category: "reorg",
        status: "open",
        note,
        createdBy: "watcher",
        createdAt: new Date(),
      });
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "code") === 11_000
      ) {
        return;
      }
      throw error;
    }
  }
}
