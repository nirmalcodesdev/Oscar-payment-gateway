import type { Connection } from "mongoose";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";
import { EnabledRegistryReader } from "../../application/registry/registry-reader.js";
import { resolveChainProviderClients } from "../chain/evm-chain-adapter.js";
import type { EvmProviderClient } from "../chain/evm-registry-verifier.js";

const providerProbeCacheMs = 5_000;
const decimalProbeCacheMs = 60_000;

export interface ReadinessCheckOutcome {
  readonly name: string;
  readonly ready: boolean;
}

interface ProviderProbe {
  readonly checkedAt: number;
  readonly ready: boolean;
}

interface DecimalProbe {
  readonly checkedAt: number;
  readonly ready: boolean;
  readonly detail: string;
}

/**
 * Bounded readiness checks for chain dependencies (ADR 0016): per enabled
 * chain, at least one configured provider must respond with the expected
 * network chain id (chain-id-level outcomes only — provider identity never
 * leaves this component), and every enabled token's live `decimals()` must
 * be verifiable and agree with stored configuration. Probes are cached so
 * readiness scrapes stay cheap; failures degrade readiness without naming
 * providers.
 */
export class ChainReadinessComponent {
  readonly #connection: Connection;
  readonly #config: RuntimeConfig;
  readonly #logger: Logger;
  readonly #providerProbes = new Map<string, ProviderProbe>();
  readonly #decimalProbes = new Map<string, DecimalProbe>();
  #snapshotAt = 0;
  #snapshot: Awaited<ReturnType<EnabledRegistryReader["refresh"]>> | undefined;

  public constructor(connection: Connection, config: RuntimeConfig, logger: Logger) {
    this.#connection = connection;
    this.#config = config;
    this.#logger = logger.child({ component: "chain-readiness" });
  }

  public async checks(): Promise<readonly ReadinessCheckOutcome[]> {
    const snapshot = await this.#snapshotCached();
    const outcomes: ReadinessCheckOutcome[] = [];
    for (const chain of snapshot.chains) {
      outcomes.push({
        name: `chain:${chain.chainId}`,
        ready: await this.#chainReady(chain),
      });
    }
    for (const token of snapshot.tokens) {
      outcomes.push({
        name: `token-decimals:${token.tokenId}`,
        ready: await this.#tokenDecimalsReady(token),
      });
    }
    return outcomes;
  }

  async #snapshotCached() {
    if (
      this.#snapshot !== undefined &&
      Date.now() - this.#snapshotAt < providerProbeCacheMs
    ) {
      return this.#snapshot;
    }
    const reader = new EnabledRegistryReader(this.#connection);
    this.#snapshot = await reader.refresh();
    this.#snapshotAt = Date.now();
    return this.#snapshot;
  }

  async #chainReady(
    chain: Awaited<ReturnType<EnabledRegistryReader["refresh"]>>["chains"][number],
  ): Promise<boolean> {
    const cached = this.#providerProbes.get(chain.chainId);
    if (cached !== undefined && Date.now() - cached.checkedAt < providerProbeCacheMs) {
      return cached.ready;
    }
    let ready = false;
    try {
      const resolved = resolveChainProviderClients({
        chainId: chain.chainId,
        rpcProviders: chain.rpcProviders,
        config: this.#config.rpc,
      });
      const results = await Promise.all(
        resolved.map(async (provider) => {
          try {
            const chainId = await provider.client.getChainId();
            return chainId === chain.networkChainId;
          } catch {
            return false;
          }
        }),
      );
      ready = results.some(Boolean);
    } catch {
      ready = false;
    }
    this.#providerProbes.set(chain.chainId, { checkedAt: Date.now(), ready });
    return ready;
  }

  async #tokenDecimalsReady(
    token: Awaited<ReturnType<EnabledRegistryReader["refresh"]>>["tokens"][number],
  ): Promise<boolean> {
    const cached = this.#decimalProbes.get(token.tokenId);
    if (cached !== undefined && Date.now() - cached.checkedAt < decimalProbeCacheMs) {
      return cached.ready;
    }
    let ready = false;
    let detail = "unverified";
    try {
      const snapshot = await this.#snapshotCached();
      const chain = snapshot.chains.find((entry) => entry.chainId === token.chain);
      if (chain === undefined) {
        detail = "chain_disabled";
      } else {
        const resolved = resolveChainProviderClients({
          chainId: chain.chainId,
          rpcProviders: chain.rpcProviders,
          config: this.#config.rpc,
        });
        const reads = await Promise.all(
          resolved.map(async (provider) => {
            const client: EvmProviderClient = provider.client;
            return client.readErc20Decimals(tokenAddress(token), BigInt(0));
          }),
        );
        const distinct = [...new Set(reads)];
        ready = distinct.length === 1 && distinct[0] === token.decimals;
        detail = ready
          ? "verified"
          : distinct.length === 1
            ? "mismatch"
            : "disagreement";
      }
    } catch {
      detail = "unavailable";
    }
    if (!ready) {
      this.#logger.warn(
        { tokenId: token.tokenId, detail },
        "Token decimals readiness degraded",
      );
    }
    this.#decimalProbes.set(token.tokenId, { checkedAt: Date.now(), ready, detail });
    return ready;
  }
}

function tokenAddress(
  token: Awaited<ReturnType<EnabledRegistryReader["refresh"]>>["tokens"][number],
): `0x${string}` {
  return token.normalizedContractAddress as `0x${string}`;
}
