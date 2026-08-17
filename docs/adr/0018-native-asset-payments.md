# ADR 0018: Native-Asset Payments on EVM Chains

- Status: Accepted
- Date: 2026-08-17
- Decision owner: Repository owner
- Relates to: ADR 0007, ADR 0009, ADR 0010, ADR 0012, ADR 0013

## Context

Phase 13 adds a second payment instrument to every enabled EVM chain: the chain's
**native gas coin** (ETH on Ethereum, POL on Polygon, BNB on BSC, and so on).
Today every layer of the deposit pipeline is ERC-20-shaped:

- `Token.contractAddress` is required and verified through contract reads
  (`src/infrastructure/mongodb/models.ts`; ADR 0007).
- The watcher filters `eth_getLogs` for the ERC-20 `Transfer` topic
  (ADR 0009) and derives amounts from decoded logs.
- `OnChainEvent` identity is `{ chain, transactionHash, logIndex }` and
  `contractAddress` is required (ADR 0010).
- QR data uses the contract-scoped EIP-681 form
  (`src/domain/chain/payment-uri.ts`).

A native coin has no contract and no `Transfer` log: the transfer is the
transaction's `value`, the recipient is the transaction `to`, and the unit is the
chain's consensus `nativeCurrency.decimals`. Supporting it requires a native path
through each layer that preserves every v1 guarantee: exactly-once crediting,
raw-event-first durability, tenant isolation, base-unit-only money, fail-closed
handling of ambiguity, and auditable reconciliation.

## Decision

### Instrument model

Extend the `Token` collection with `assetType: "erc20" | "native"` (default
`"erc20"`, so every existing row is unaffected). A native token record:

- has `contractAddress` and `normalizedContractAddress` absent (`null`);
- uses the parent chain's `nativeCurrency.symbol` as its `symbol`;
- snapshots `decimals` from the parent chain's `nativeCurrency.decimals` at
  creation time (immutable thereafter, exactly like ERC-20 decimals);
- keeps `minAmount`/`maxAmount`, `verificationPolicy`, `enabled`,
  `verificationStatus`, `version`, and `allocationSequence` semantics unchanged;
- is unique per chain: a partial unique index on `{ chain, assetType }` scoped to
  `assetType: "native"` permits at most one native token per chain. The existing
  `{ chain, symbol }` and `{ chain, normalizedContractAddress }` constraints are
  untouched.

### Verification policy for native tokens

Activation requires the parent chain to be `enabled` and freshly verified, and:

- verifies the numeric chain identity through all selected providers via the shared
  viem infrastructure (ADR 0003), reusing the ADR 0007 chain-activation check;
- cross-checks the requested decimals against the parent chain's
  `nativeCurrency.decimals` — a mismatch is a hard activation failure;
- records `verificationStatus: "verified"`, `verifiedAt`, and
  `verifiedDecimals`.

`manual_review` classification does not apply there is no contract for it to
describe. `verificationPolicy` remains required: `event_only` is the default
(the transaction `value` is the authoritative amount), while
`balance_delta_required` stays available for high-value native tokens where an
operator wants independent corroboration of the recipient balance delta.

### Event identity

Native transfers are identified by `transactionHash` alone: one top-level
transaction can target at most one watched address. `OnChainEvent` gains
`assetType` (default `"erc20"`) and `logIndex` becomes optional. The `eventId`
for native events is `native_tx_<lowercase-txHash>`.

MongoDB collapses multiple `null` values in a compound unique index, so the
existing `{ chain, transactionHash, logIndex }` uniqueness cannot carry native
rows. Two partial indexes replace none of the existing semantics:

- `{ chain, transactionHash, logIndex }` unique, partial-filtered to
  `logIndex` present (ERC-20 events);
- `{ chain, transactionHash }` unique, partial-filtered to `logIndex` absent
  (native events).

Native events carry `fromAddress`/`toAddress` and the value as the existing
`amount` field (base-unit integer string, immutable), and never a
`contractAddress`.

### Detection mechanism

For chains with at least one enabled native token, the EVM adapter additionally
fetches each block's transactions in the existing batch loop. A candidate native
event is a transaction whose normalized `to` matches a watched native address,
whose `value` is positive, and whose receipt status is success (`0x1`). The
same durable cursor, block-header parent-hash continuity, independent-provider
hash corroboration, and halt-on-discontinuity behavior (ADR 0009) apply. The
verbatim transaction plus block metadata is the `rawEvent`.

Watched native addresses come from the same `EnabledRegistryReader` refresh cadence
as ERC-20 recipients, so a newly activated native token starts being watched
within `WATCHER_REGISTRY_REFRESH_SEC` with no restart.

### Payment URI

Native payments use the canonical token-less EIP-681 transfer form:

`ethereum:<recipient>@<networkChainId>?value=<base-units>`

The ERC-20 contract-scoped form is unchanged. `POST /api/v1/payments` takes a
native token's `tokenId` exactly as for ERC-20; response gains an additive
`assetType` field. Snapshot reservation, expiry clamping, idempotency keys,
tenant scoping, and destination screening at creation are unchanged. The `from`
address of a native transfer is screened before `confirming → confirmed` exactly
as an ERC-20 sender.

## Consequences

- **Migration 0006 is additive but rotates the migration-0001 checksum.** The
  0001 manifest is computed from the live Mongoose model definitions (indexes and
  validators), so adding `assetType`, making two fields optional, and adding two
  partial indexes changes the recorded 0001 checksum. This is documented
  repository behavior: a database settled at schema v5 fails the compatibility
  check against the new catalog and must be re-created (fresh databases settle at
  v6; migration 0006 backfills `assetType: "erc20"` on pre-existing rows).
  Production upgrades follow the documented controlled-recreation process rather
  than an in-place alter.
- The compatibility range moves from `5-5` to `6-6`; integration assertions
  that expect schema v5 are updated to v6.
- Native detection costs full-block fetching only on chains with at least one
  enabled native token, keeping the watcher cost proportional to configured
  assets.
- Reconciliation, screening, webhooks, confirmation, reorg, and expiry paths are
  reused verbatim: native assets flow through the same state machine rather than a
  parallel one.
- **Internal transfers are not detected in v1.** Value moved to a watched address
  by a contract call is not observed from the transaction header. Such funds
  surface as orphaned deposits in reconciliation for manual review — never
  silently dropped. Operators who accept internal-transfer risk for a native token
  select `balance_delta_required` and reconcile orphans. This limitation is
  documented in the README.
