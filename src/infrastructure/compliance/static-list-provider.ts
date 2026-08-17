import type {
  SanctionsScreeningProvider,
  ScreeningRequest,
  ScreeningResult,
} from "../../domain/compliance/screening-provider.js";

export interface StaticSanctionsListConfig {
  readonly listVersion: string;
  readonly addresses: readonly string[];
}

const providerName = "static-list";
const providerVersion = "1";

export class StaticSanctionsListProvider implements SanctionsScreeningProvider {
  readonly #normalizedAddresses: ReadonlySet<string>;
  readonly #listVersion: string;

  public constructor(config: StaticSanctionsListConfig) {
    this.#listVersion = config.listVersion;
    this.#normalizedAddresses = new Set(
      config.addresses.map((address) => address.toLowerCase()),
    );
  }

  /**
   * The environment list version. Exposed so the updateable provider can
   * surface a stable version even when no managed list exists, keeping
   * version-aware verdict invalidation exact across a managed-list retirement.
   */
  public get listVersion(): string {
    return this.#listVersion;
  }

  public screen(request: ScreeningRequest): Promise<ScreeningResult> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(request.address)) {
      return Promise.resolve({
        verdict: "indeterminate",
        riskLevel: "unknown",
        sanctioned: false,
        provider: providerName,
        providerVersion,
        listVersion: this.#listVersion,
        rawResponse: { matcher: "static-list", reason: "address_format_invalid" },
      });
    }
    const normalized = request.address.toLowerCase();
    const matched = this.#normalizedAddresses.has(normalized);
    return Promise.resolve({
      verdict: matched ? "blocked" : "clear",
      riskLevel: matched ? "blocked" : "clear",
      sanctioned: matched,
      provider: providerName,
      providerVersion,
      listVersion: this.#listVersion,
      rawResponse: { matcher: "static-list", matched },
    });
  }
}
