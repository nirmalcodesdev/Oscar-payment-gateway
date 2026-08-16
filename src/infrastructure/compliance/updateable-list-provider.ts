import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import type {
  SanctionsScreeningProvider,
  ScreeningRequest,
  ScreeningResult,
} from "../../domain/compliance/screening-provider.js";
import { registerPersistenceModels } from "../mongodb/models.js";
import { StaticSanctionsListProvider } from "./static-list-provider.js";

const providerName = "managed-list";
const providerVersion = "1";
const memoryRefreshMs = 30_000;

interface ManagedListState {
  readonly listId: string;
  readonly listVersion: string;
  readonly source: string;
  readonly contentHash: string;
  readonly addresses: ReadonlySet<string>;
  readonly ingestedAt: Date;
}

/**
 * Updateable OFAC-style list provider (ADR 0013). Resolves the single active
 * managed list from MongoDB, normalizes addresses deterministically to
 * lowercase EVM form, and caches the set in memory with a bounded refresh.
 *
 * Fail-closed behavior:
 * - A managed list older than `SCREENING_LIST_MAX_AGE_SEC` yields
 *   `unavailable` for every screen — a stale list can never approve.
 * - A database read failure yields `unavailable`.
 * - With no managed list, the environment static list is used as the
 *   bootstrap fallback (provenance `environment`); freshness enforcement
 *   applies only to managed lists.
 */
export class UpdateableSanctionsListProvider implements SanctionsScreeningProvider {
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #fallback: StaticSanctionsListProvider;
  readonly #maxAgeMs: number;
  readonly #logger: Logger;
  #cached: ManagedListState | undefined;
  #cachedAt = 0;

  public constructor(
    connection: Connection,
    config: RuntimeConfig["compliance"],
    logger: Logger,
  ) {
    this.#models = registerPersistenceModels(connection);
    this.#fallback = new StaticSanctionsListProvider(config.sanctionsStaticList);
    this.#maxAgeMs = config.screeningListMaxAgeSec * 1_000;
    this.#logger = logger.child({ component: "sanctions-list-provider" });
  }

  /** Force the next screen to re-read the active list (called after updates). */
  public invalidate(): void {
    this.#cached = undefined;
    this.#cachedAt = 0;
  }

  /**
   * Current active managed-list version for cache invalidation (ADR 0013).
   * `undefined` when no managed list exists (the environment fallback's
   * version does not change at runtime).
   */
  public async activeListVersion(): Promise<string | undefined> {
    if (this.#cached !== undefined) return this.#cached.listVersion;
    const list = await this.#models.SanctionsList.findOne({ status: "active" })
      .select({ listVersion: 1 })
      .lean();
    return list?.listVersion;
  }

  public async screen(request: ScreeningRequest): Promise<ScreeningResult> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(request.address)) {
      return {
        verdict: "indeterminate",
        riskLevel: "unknown",
        sanctioned: false,
        provider: providerName,
        providerVersion,
        rawResponse: { matcher: providerName, reason: "address_format_invalid" },
      };
    }
    const managed = await this.#activeList();
    if (managed === null) {
      return this.#fallback.screen(request);
    }
    if (managed === undefined) {
      return {
        verdict: "unavailable",
        riskLevel: "unknown",
        sanctioned: false,
        provider: providerName,
        providerVersion,
        rawResponse: { matcher: providerName, reason: "managed_list_unavailable" },
      };
    }

    const ageMs = Date.now() - managed.ingestedAt.getTime();
    if (ageMs > this.#maxAgeMs) {
      this.#logger.error(
        { listId: managed.listId, listVersion: managed.listVersion, ageMs },
        "Managed sanctions list is stale; screening fails closed",
      );
      return {
        verdict: "unavailable",
        riskLevel: "unknown",
        sanctioned: false,
        provider: providerName,
        providerVersion,
        listVersion: managed.listVersion,
        rawResponse: {
          matcher: providerName,
          reason: "managed_list_stale",
          listId: managed.listId,
        },
      };
    }

    const normalized = request.address.toLowerCase();
    const matched = managed.addresses.has(normalized);
    return {
      verdict: matched ? "blocked" : "clear",
      riskLevel: matched ? "blocked" : "clear",
      sanctioned: matched,
      provider: providerName,
      providerVersion,
      listVersion: managed.listVersion,
      rawResponse: {
        matcher: providerName,
        matched,
        listId: managed.listId,
        contentHash: managed.contentHash,
        source: managed.source,
      },
    };
  }

  /**
   * Resolve the current managed list state:
   * - `undefined` when the database read fails (fail closed),
   * - `null` when no managed list exists (environment fallback applies).
   */
  async #activeList(): Promise<ManagedListState | null | undefined> {
    if (this.#cached !== undefined && Date.now() - this.#cachedAt < memoryRefreshMs) {
      return this.#cached;
    }
    try {
      return await this.#loadActiveList();
    } catch (error: unknown) {
      this.#logger.error(
        { err: error },
        "Managed sanctions list read failed; screening fails closed",
      );
      return undefined;
    }
  }

  async #loadActiveList(): Promise<ManagedListState | null> {
    const list = await this.#models.SanctionsList.findOne({ status: "active" }).lean();
    if (list === null) return null;
    const addresses = await this.#models.SanctionsAddress.find({
      listId: list.listId,
    })
      .select({ normalizedAddress: 1 })
      .lean();
    const state: ManagedListState = {
      listId: list.listId,
      listVersion: list.listVersion,
      source: list.source,
      contentHash: list.contentHash,
      addresses: new Set(addresses.map((entry) => entry.normalizedAddress)),
      ingestedAt: list.ingestedAt,
    };
    this.#cached = state;
    this.#cachedAt = Date.now();
    return state;
  }
}
