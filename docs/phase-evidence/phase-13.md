# Phase 13 Validation Evidence

- Branch: `phase/13-native-assets`
- Status: Complete
- Started: 2026-08-17
- Completed: 2026-08-17

## ADR review

Outcome: New ADR required and accepted before dependent implementation.

Reviewed sources:

- `prompt.md` §3.6 native-currency metadata requirement, §10 pluggable
  screening provider, known pitfalls on fee-on-transfer detection and nothing but
  an explicitly configured token being watched.
- `phases.md` fixed architectural decisions: base-unit-only money, viem-only
  chain client, deposit-allocation Option A, durable raw-event first,
  chain/token registry policy, and RPC ownership policy.
- ADRs 0007 (registry verification), 0009 (durable watcher), 0010 (ingestion
  and interpretation), 0012 (reorg/finality), 0013 (screening).

Accepted for this phase:

- ADR 0018: native-asset payments on EVM chains — instrument model, event
  identity, detection mechanism, verification policy, and migration
  consequences.

## Delivered contracts

- `Token` and `OnChainEvent` gain `assetType` with default `"erc20"` and an
  optional contract address / log index for native rows; partial unique indexes
  enforce at most one native token per chain and exactly-once native event
  identity.
- Migration 0006 backfills `assetType: "erc20"`, relaxes the `tokens` and
  `on_chain_events` validators, and settles the database at schema version 6.
  The migration runner command is unchanged, but integration assertions on the
  settled version now expect 6, and the runner self-repairs a `version` field
  left behind an applied migrations array.
- Native token creation/activation verifies the chain identity and cross-checks
  the decimals against `nativeCurrency`; no contract reads. The live registry
  reader projects native tokens without a contract address.
- The EVM adapter and watcher scan full block transactions only for chains with
  an enabled native token, emitting candidates as value-bearing top-level
  transfers to a watched recipient.
- Ingestion derives `eventId = native_tx_<hash>` for native events; the internal
  endpoint schema accepts optional `assetType`, `contractAddress`, and `logIndex`.
- Native interpretation re-derives fields from the raw transaction, resolves the
  native token by `(chain, assetType)`, and applies balance-delta
  corroboration for `balance_delta_required` tokens.
- Payment URIs use the canonical token-less EIP-681 form
  (`ethereum:<recipient>@<chainId>?value=<amount>`) for native assets.
- README and `docs/REGISTRY.md` document the instrument and the top-level-only
  detection limitation.

## Validation results

- `npm run validate`: formatting, zero-warning lint, strict typecheck, 311 unit
  tests across 38 files, production build, Compose structural validation, and
  sanitized fail-closed entrypoint checks all passed.
- Full integration suite: 117 tests across 9 files passed on consecutive runs
  against a recreated schema-v6 database. `npm run test:integration` exercised
  idempotent registration, live chain/token verification, and the migration
  compatibility controls.

## Defects found and corrected

- Mongo partial-index filters only support a subset of operators; the native
  exactly-once index initially used `{ logIndex: { $exists: false } }`, which
  MongoDB rejects. Corrected to `{ logIndex: { $type: "null" } }` with native
  rows storing `logIndex: null`.
- The migration runner could return a stale `version` field while its migration
  array was ahead (an interrupted prior run); it now treats the array as
  authoritative and self-repairs the field.

## Live-chain validation

Beyond the automated gates, the native and ERC-20 happy paths were exercised
against live Sepolia and Base Sepolia testnets (real funds, no mocks):

- Native deposits confirmed at the configured 12-block depth with exact amount
  receipts, signed `payment.confirmed` webhook delivered with a valid HMAC.
- ERC-20 deployed, registered, and activated with live `symbol()`/`decimals()`
  verification.
- Financial edges observed live: overpay confirmed with exact excess and a
  reconciliation annotation; wrong-token deposit rejected; late-after-expiry
  deposits routed to reconciliation, never auto-credited.
- Compliance hold→release exercised live: a sanctioned sender deposit was matched,
  held (`screeningStatus: blocked`), then released via an audited admin decision
  to `screeningStatus: clear`.
- Fail-closed behavior observed live: the durable cursor holds the chain when the
  independent-provider header corroboration disagrees at the tip.

Two additional defects found and fixed live:

- Wallet registration raced the watcher's periodic registry refresh, so a deposit
  in that window could be missed; fixed with a Redis pub/sub signal that refreshes
  the watcher immediately (commit `78edd03`).
- Observed-block cursor advance could abort on a duplicate-key when a block was
  re-observed with an already-recorded identity; fixed by an idempotent upsert
  (commit `ae81bd3`).

## Completion decision

Every Phase 13 deliverable passes its gate. The branch is eligible for its
completion commit and merge into `main`. This does not declare the gateway
production-ready; the Phase 12 release gates remain mandatory.
