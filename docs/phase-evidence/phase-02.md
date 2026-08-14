# Phase 02 Validation Evidence

- Branch: `phase/02-persistence-invariants`
- Status: Complete
- Completed: 2026-08-14

## ADR review

Outcome: New ADR required and accepted before dependent implementation.

Reviewed sources:

- `prompt.md` persistence contracts, transaction, idempotency, audit,
  compliance, reorg, migration, and production-safety requirements.
- `phases.md` fixed decisions, cross-phase invariants, and Phase 02
  deliverables and validation gate.
- ADRs 0001 through 0004.

Accepted for this phase:

- ADR 0005: strict persistence boundaries, direct-write validators,
  transaction requirements, audit-chain integrity, migration compatibility,
  runtime/migration privilege separation, and TTL policy.

## Delivered contracts

- Strict-throw Mongoose schemas cover all Phase 02 entities and reject unknown
  fields and invalid query filters.
- Money is represented only as canonical base-unit integer strings and native
  `bigint`; Mongoose casting is disabled on monetary paths.
- Stable named unique, compound, partial, lookup, and safe TTL indexes enforce
  event identity/claim, address derivation/allocation, payment-address,
  idempotency, and query-path invariants.
- Raw event identity and retained financial history cannot be deleted through
  model APIs. Audit entries are append-only and protected by per-scope SHA-256
  hash chains with transactional chain-head advancement.
- Correctness-critical operations require a writable replica set or sharded
  topology and use snapshot/majority/primary transactions with bounded body
  and commit retry behavior.
- Migration 0001 creates validators and indexes explicitly, records a manifest
  checksum, uses a lease, checks runtime compatibility, and runs before every
  application process with a separate migration identity.
- Runtime Mongoose connections use `autoIndex: false` and reject incompatible
  database schema versions.
- Deployment, least-privilege, forward-only evolution, compatibility, and
  rollback procedures are documented in `docs/PERSISTENCE.md`.

## Validation results

### Static, unit, and build gates

- `npm.cmd run validate`: passed formatting, zero-warning lint, strict type
  checking, 60 unit tests across 12 files, production build, Compose structural
  validation, and sanitized fail-closed entrypoint checks.
- `npm.cmd run test:coverage`: passed all 80% thresholds with 86.00% statements,
  84.89% branches, 82.14% functions, and 86.00% lines.
- `npm.cmd audit --audit-level=high`: passed online with zero vulnerabilities.
- `git diff --check`: passed with no whitespace errors.

### Live replica-set gates

- `npm.cmd run test:integration`: 15 tests passed across 2 files without skips.
- Concurrent writes proved atomic rejection of duplicate raw events, event
  claims, derivation allocations, payment assignments, payment wallet
  addresses, and scoped idempotency keys.
- Live audit tests proved append-only model behavior, direct tamper detection,
  detection when all entries are removed but a head remains, and serialization
  of eight simultaneous writers into one contiguous chain.
- Transaction tests proved replica-set capability, commit, forced rollback of
  payment/address/audit/head state, and safe retry of an ambiguous commit
  without rerunning the transaction body.
- Direct MongoDB writes with invalid money formats were rejected by collection
  validation.
- Migration tests proved idempotence, lease exclusion, checksum tamper refusal,
  and runtime compatibility refusal.

### Migration and service evidence

- Final database schema version: `1`.
- Final migration manifest checksum:
  `e00591dfb40834a7080dddd79aceac13c2cb9657a0769b01effd0a358b3d4e80`.
- The runtime identity is `oscar_app`; the separate migration identity is
  `oscar_migrate` with the additional local `dbAdmin` permission required for
  validators and indexes.
- The final full `docker compose up --build --wait --wait-timeout 300` rebuilt
  every application image, ran replica-set initialization and migration to
  exit code 0, and brought all long-running services to healthy/running state.
- Live `/health` returned `{"status":"ok"}` and `/ready` returned
  `{"status":"ready"}` through `127.0.0.1:3000`.
- MongoDB inspection confirmed `uq_payment_wallet_address` is unique and both
  `ix_event_chain_contract_block` and
  `ix_event_chain_normalized_contract_block` are installed.

### CI and security gates

- `npm.cmd run verify:ci-negative-controls`: isolated type, test, and secret
  fixtures were all rejected.
- Pinned Gitleaks `8.28.0` scanned approximately 862 KB across the complete
  final worktree and reported no leaks.
- The final review found no signing material, private credentials, unprotected
  monetary casts, TTL indexes on retained financial/audit history, or
  correctness-critical check-then-write logic.

## Defects found and corrected

- Disabled Mongoose string casting after proving numeric money input was being
  coerced into a superficially valid string.
- Split runtime and migration database identities after live `collMod`
  validation proved the runtime role correctly lacked schema-administration
  permission.
- Replaced a static migration checksum with a checksum of the actual validator
  and index manifest.
- Added distinct exact and normalized contract-address event indexes.
- Corrected a rollback-test address collision and made concurrent audit-head
  creation retry safely.
- Made empty retained audit data with a non-empty chain head fail verification.
- Changed ambiguous commit handling to retry the commit only, never the
  transaction body.
- Added a global unique payment-wallet-address index and concurrent proof so a
  single payment address cannot back two payment intents.

## Completion decision

Every Phase 02 deliverable and applicable validation gate has passed. The
phase branch is eligible for its completion commit and merge into `main`.
