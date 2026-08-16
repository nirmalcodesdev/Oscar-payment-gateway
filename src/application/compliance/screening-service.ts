import { randomUUID } from "node:crypto";

import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import type {
  SanctionsScreeningProvider,
  ScreeningRequest,
  ScreeningResult,
} from "../../domain/compliance/screening-provider.js";
import { registerPersistenceModels } from "../../infrastructure/mongodb/models.js";

/**
 * Provider whose active list version can change at runtime (ADR 0013).
 * Exposed by the updateable managed-list provider; the screening service
 * invalidates cached verdicts when the version moves.
 */
export interface ListVersionAwareProvider {
  activeListVersion(): Promise<string | undefined>;
}

const verdicts: readonly ScreeningResult["verdict"][] = [
  "clear",
  "flagged",
  "blocked",
  "unavailable",
  "indeterminate",
];
const riskLevels: readonly ScreeningResult["riskLevel"][] = [
  "clear",
  "low",
  "medium",
  "high",
  "blocked",
  "unknown",
];

/**
 * Screening facade with a short-TTL ComplianceScreening cache (ADR 0013).
 * A cached verdict is reused only while unexpired and only when the
 * provider's current list version matches the cached one, so a list update
 * invalidates every prior verdict. Provider failures are sanitized and map
 * to `unavailable`; malformed results map to `indeterminate` — neither ever
 * approves a payment. Every provider call is recorded in
 * `ComplianceScreening` with provider, time, risk, list version, and a raw
 * response excluded from default projections.
 */
export class ScreeningService implements SanctionsScreeningProvider {
  readonly #models: ReturnType<typeof registerPersistenceModels>;
  readonly #provider: SanctionsScreeningProvider;
  readonly #providerId: string;
  readonly #listVersionAware: ListVersionAwareProvider | undefined;
  readonly #config: RuntimeConfig["compliance"];
  readonly #logger: Logger;

  public constructor(
    connection: Connection,
    config: RuntimeConfig["compliance"],
    provider: SanctionsScreeningProvider,
    logger: Logger,
    options: { readonly providerId?: string } = {},
  ) {
    this.#models = registerPersistenceModels(connection);
    this.#provider = provider;
    this.#providerId = options.providerId ?? "sanctions-provider";
    const versionCapable = provider as { activeListVersion?: unknown };
    this.#listVersionAware =
      typeof versionCapable.activeListVersion === "function"
        ? (provider as unknown as ListVersionAwareProvider)
        : undefined;
    this.#config = config;
    this.#logger = logger.child({ component: "screening-service" });
  }

  public async screen(request: ScreeningRequest): Promise<ScreeningResult> {
    const cached = await this.#reusableVerdict(request);
    if (cached !== undefined) {
      return cached;
    }

    let result: ScreeningResult;
    try {
      result = await this.#provider.screen(request);
    } catch (error: unknown) {
      // Sanitized: provider payloads and credentials never reach logs.
      this.#logger.warn(
        { err: new Error((error as Error).message) },
        "Screening provider failed; treating as unavailable",
      );
      result = {
        verdict: "unavailable",
        riskLevel: "unknown",
        sanctioned: false,
        provider: this.#providerId,
        rawResponse: { reason: "provider_error" },
      };
    }
    if (!isWellFormedResult(result)) {
      this.#logger.warn(
        "Screening provider returned a malformed result; treating as indeterminate",
      );
      result = {
        verdict: "indeterminate",
        riskLevel: "unknown",
        sanctioned: false,
        provider: this.#providerId,
        rawResponse: { reason: "malformed_provider_response" },
      };
    }

    const checkedAt = new Date();
    await this.#models.ComplianceScreening.create({
      screeningId: `screen_${randomUUID()}`,
      address: request.address,
      normalizedAddress: request.address.toLowerCase(),
      chain: request.chain,
      provider: result.provider,
      verdict: result.verdict,
      riskLevel: result.riskLevel,
      sanctioned: result.sanctioned,
      checkedAt,
      rawResponse: result.rawResponse,
      ...(result.providerVersion === undefined
        ? {}
        : { providerVersion: result.providerVersion }),
      ...(result.listVersion === undefined ? {} : { listVersion: result.listVersion }),
      expiresAt: new Date(
        checkedAt.getTime() + this.#config.screeningCacheTtlSec * 1000,
      ),
    });
    return result;
  }

  /**
   * Cached verdict reuse: unexpired, carrying a verdict, and recorded
   * against the provider's current active list version when the provider is
   * version-aware — a list update invalidates every prior verdict. Records
   * from a provider without runtime list changes are bounded by the TTL
   * alone (its list only changes on redeploy). Expired records are removed
   * by the TTL index, forcing a fresh call.
   */
  async #reusableVerdict(
    request: ScreeningRequest,
  ): Promise<ScreeningResult | undefined> {
    const cached = await this.#models.ComplianceScreening.findOne({
      normalizedAddress: request.address.toLowerCase(),
      chain: request.chain,
      verdict: { $exists: true },
      expiresAt: { $gt: new Date() },
    })
      .sort({ checkedAt: -1 })
      .lean();
    if (cached === null) return undefined;

    if (this.#listVersionAware !== undefined) {
      const currentVersion = await this.#listVersionAware.activeListVersion();
      if (currentVersion !== undefined && cached.listVersion !== currentVersion) {
        return undefined;
      }
    }
    return {
      verdict: cached.verdict as ScreeningResult["verdict"],
      riskLevel: cached.riskLevel as ScreeningResult["riskLevel"],
      sanctioned: cached.sanctioned,
      provider: cached.provider,
      providerVersion: cached.providerVersion,
      listVersion: cached.listVersion,
      rawResponse: { cache: "hit", screeningId: cached.screeningId },
    };
  }
}

function isWellFormedResult(result: ScreeningResult): boolean {
  return (
    verdicts.includes(result.verdict) &&
    riskLevels.includes(result.riskLevel) &&
    typeof result.sanctioned === "boolean" &&
    typeof result.provider === "string" &&
    result.provider.length > 0 &&
    typeof result.rawResponse === "object"
  );
}
