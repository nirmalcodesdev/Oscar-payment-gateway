# ADR 0009: Chain Adapter Contract and Durable Watcher Pipeline

- Status: Accepted
- Date: 2026-08-15
- Decision owner: Repository owner
- Relates to: `REQ-03G`, `REQ-05`, `REQ-12`, `REQ-14`

## Context

Phase 06 must observe configured EVM chains continuously and deliver every
potentially relevant ERC-20 `Transfer` log into the durable ingestion pipeline
without trusting any single RPC provider, skipping blocks across restarts, or
advancing sync state ahead of durable writes. `prompt.md` §5 fixes the exact
chain-neutral `ChainAdapter` contract and requires multi-provider redundancy,
poll-and-catch-up behavior, decimal verification against live contracts, and
explicit token-registry gating. ADR 0003 requires Phase 06 to compose the
Phase 04 shared viem infrastructure instead of creating a second client stack.
ADR 0004 assigns chain observation and durable ingestion to the `watcher`
process. Phase 07 owns payment matching, state transitions, and reorg recovery,
so Phase 06 must stop at durable, verified event capture plus fail-closed
halts that leave recovery inputs intact.

## Decision

### ChainAdapter contract

The domain layer defines the exact chain-neutral contract from `prompt.md`:

```ts
interface ChainAdapter {
  chainId: string;
  init(): Promise<void>;
  getCurrentBlock(): Promise<number>;
  getConfirmations(txHash: string): Promise<number>;
  isCanonical(txHash: string, expectedBlockNumber: number): Promise<boolean>;
  watchDeposits(callback: (event: OnChainDepositEvent) => Promise<void>): void;
  stop(): Promise<void>;
}
```

- `OnChainDepositEvent` is chain-neutral: registry `chain` identity, contract
  address, transaction hash, log index, block number, block hash, from/to
  addresses, a base-unit integer string `amount`, and the verbatim provider log
  as `rawEvent`. No viem or EVM type appears in the domain contract.
- A factory selects the implementation by `Chain.networkFamily` (`evm` in v1)
  and fails closed for unknown families. The EVM adapter is the only
  implementation and lives in infrastructure; shared interfaces never carry
  EVM-only assumptions.
- `watchDeposits` is driven by bounded polling, not websockets. Polling alone
  satisfies the "poll AND catch up" requirement and removes a silently dropping
  subscription path. `stop()` halts timers and in-flight work deterministically
  for graceful shutdown.
- `getConfirmations` and `isCanonical` are implemented in Phase 06 against the
  shared provider client (transaction receipt plus current block; block-hash
  comparison at the expected height) and are consumed by Phase 07 confirmation
  logic. Phase 06 uses them for ingest-time context only.

### Shared provider extension (ADR 0003 composition)

The Phase 04 `EvmProviderClient` interface is extended in place with
`getLogs(filter)`, `getBlockByNumber(blockNumber)`,
`getTransactionReceipt(txHash)`, and `readErc20Balance(contract, holder,
blockNumber)`. The same factory, operator-configured URL resolution, bounded
timeouts, and error classification remain authoritative. No second viem client
stack is introduced.

### Provider health, failover, disagreement, and metrics

- Each chain adapter holds clients for every configured provider reference and
  reuses the Phase 04 resolution rules: catalog membership, operator match,
  distinct operators, and at least two providers.
- `init()` verifies the numeric chain identity through all providers before any
  polling starts. Mismatch or unavailability fails watcher startup for that
  chain (fail closed) and reports degraded readiness.
- One provider is active at a time, selected in configured order by health.
  Consecutive failures mark a provider unhealthy and fail over to the next;
  recovery requires a successful verified call. Every failover and every total
  connectivity loss emits a structured alert log and increments an in-process
  failover counter exposed through logs (the v1 metrics surface).
- Block batches fetched from the active provider are cross-checked against at
  least one independent provider for block hash agreement at the same height.
  Disagreement is fail-closed: the batch is discarded, the cursor does not
  advance, an alert is emitted, and the batch is retried later.

### Durable cursor and batch pipeline

- The watcher maintains a per-chain poll loop: read the persisted
  `ChainCursor`, fetch blocks from `lastProcessedBlock + 1` through
  `min(head, lastProcessedBlock + batchSize)`, and process them in order.
- Log retrieval filters by configured token contract addresses and the ERC-20
  `Transfer` topic; recipient relevance is checked client-side against the
  refreshed assigned-address set so unrelated token traffic is not persisted.
- For each relevant log the watcher submits the verbatim provider log to the
  internal ingestion endpoint (ADR 0010). The endpoint is the single
  persistence boundary for raw events.
- After every relevant event in a block range is acknowledged by the ingestion
  endpoint, the watcher advances the cursor inside one MongoDB transaction that
  also writes the `ObservedBlock` metadata (number, hash, parent hash) for the
  range. The cursor update is conditional on the stored cursor version
  (optimistic concurrency), so overlapping watcher instances cannot double
  advance. Cursor advancement never precedes durable event writes.
- On startup and after any interruption the same catch-up path runs from the
  persisted cursor; no in-memory position is authoritative.
- If an observed block's parent hash does not match the previously recorded
  hash for the parent height, the watcher halts that chain, alerts, and leaves
  the cursor before the discontinuity. Phase 07 owns fork resolution; Phase 06
  must only refuse to build on an inconsistent history.

### Live registry refresh and decimal guard

- The watcher refreshes the enabled registry through the Phase 04
  `EnabledRegistryReader` and the assigned `WalletAddress` set on a bounded
  interval without restart. The active watchlist (contracts, recipients,
  policies, revision) swaps atomically between poll cycles.
- At watcher startup and on every refresh that adds or changes a token, the
  adapter re-reads the live `decimals()` of that enabled token contract through
  at least two independent providers at a shared block, reusing the Phase 04
  verification behavior.
- On decimal mismatch, provider disagreement, missing metadata, or an
  unverifiable response, the token is excluded from the watchlist, watcher
  readiness degrades, a structured alert is emitted, and an append-only audit
  entry records the exclusion. Registry documents are not mutated: resolution
  requires an admin registry command (ADR 0007), which is the documented review
  path.
- Tokens already excluded remain excluded until a refresh observes them enabled
  and decimal-verified again.

### Watcher process composition

The watcher process registers managed resources in the existing lifecycle:
MongoDB, Redis, then a `WatcherResource` that owns adapters, the registry
refresh timer, and the poll loops. Readiness requires healthy dependencies and
at least one watchable chain when enabled chains exist; decimal-guard
exclusions degrade readiness without crashing the process.

## Threat assumptions

- Any single RPC provider can be unavailable, stale, forked, or malicious.
- Watcher instances can overlap during deploys and crash restarts.
- The process can stop between fetching logs, submitting events, and advancing
  the cursor; replay must be safe.
- Token contracts can change behavior (decimals, metadata) after activation.

## Consequences

- Restart and provider-outage tests can prove no block range is skipped because
  the persisted cursor is the only sync position and advancement is
  transactional behind durable event writes.
- Duplicate event submission is possible by design (at-least-once transport);
  ADR 0010 database uniqueness makes the effective outcome exactly once.
- Phase 07 receives durably stored raw events, observed block metadata, and a
  clean halt point for any discontinuity, which is everything reorg recovery
  requires.
- Decimal-guard exclusions are observable and admin-resolvable without any
  automatic registry mutation.
- Polling-only watching trades latency for determinism; the bounded poll
  interval is operator-configurable.

## Verification

- Unit tests cover adapter factory selection, provider health/failover,
  chain-ID verification failure, disagreement handling, cursor conditional
  advancement, and decimal-guard exclusion logic with fake providers.
- Integration tests prove catch-up after restart, no skipped ranges under
  provider outage, cursor-behind-durable-writes ordering, live registry refresh
  without restart, and decimal-mismatch watch exclusion with degraded readiness.
