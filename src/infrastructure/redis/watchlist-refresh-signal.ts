import type { Redis } from "ioredis";

/**
 * Redis pub/sub channel that carries a refresh signal to the watcher process
 * whenever a wallet address becomes newly watchable (payment assignment or wallet
 * registration). The watcher subscribes and refreshes immediately, closing the
 * window where a deposit could land before the periodic refresh observed the
 * address. The periodic timer remains the fallback when Redis is unavailable.
 */
export function walletWatchlistRefreshChannel(queuePrefix: string): string {
  return `${queuePrefix}:wallet-watchlist-refresh`;
}

/**
 * Fire-and-forget notifier. Loses no correctness if publishing fails: the
 * watcher's periodic refresh still observes the new address within
 * `WATCHER_REGISTRY_REFRESH_SEC`.
 */
export function signalWalletWatchlistRefresh(redis: Redis, queuePrefix: string): void {
  redis.publish(walletWatchlistRefreshChannel(queuePrefix), "refresh").catch(() => {
    // Best effort only; the polling timer is the durability backstop.
  });
}

export { walletWatchlistRefreshChannel as watchlistRefreshChannel };
