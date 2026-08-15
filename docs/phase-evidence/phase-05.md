# Phase 05 Validation Evidence

- Branch: `phase/05-payment-intents`
- Status: Complete
- Completed: 2026-08-15

## ADR review

Outcome: New ADR required and accepted before dependent implementation.

Reviewed sources:

- `prompt.md` payment creation, address allocation Option A, idempotency,
  expiry clamping, destination screening, payment status, tenant isolation,
  EIP-681, and production-safety requirements.
- `phases.md` fixed architectural decisions and the Phase 05 deliverables and
  validation gate.
- ADRs 0001 through 0007, including the ADR 0007 registry snapshot contract
  that Phase 05 must use and the ADR 0006 wallet and scope boundaries.

Accepted for this phase:

- ADR 0008: public-only derivation scheme, atomic monotonic index allocation,
  assigned address lifecycle, payment creation transaction order, idempotency
  semantics, destination screening boundary with Phase 08, expiry policy,
  merchant API response contract, and the unchanged persistence boundary.

## Delivered contracts

- `POST /api/v1/payments` creates a pending payment inside one replica-set
  transaction: registry snapshot reservation, token min/max bounds check,
  merchant liveness check, atomic monotonic derivation-index allocation on the
  merchant's active wallet, public-only address derivation, destination
  screening, immutable `WalletAddress` assignment, `Payment` insert, screening
  record, append-only hash-chained audit entry, and the idempotency record.
- Public-only derivation never references private paths; the stored xpub is
  selected with `+publicExtendedKey` only inside the creation transaction and
  never appears in responses, audit projections, or logs.
- Merchant-scoped `Idempotency-Key` replay returns the stored response for an
  identical request fingerprint, rejects key reuse with a different fingerprint
  (`409 IDEMPOTENCY_CONFLICT`), and concurrent duplicate submissions create
  exactly one payment through the unique idempotency index.
- Expiry is server-clamped to `PAYMENT_EXPIRY_MIN_SEC`/`PAYMENT_EXPIRY_MAX_SEC`
  with the configured default; amounts are positive base-unit integer strings
  bounded by the token registry.
- Destination screening runs fail-closed inside the transaction using the
  operator-configured static list; blocked destinations persist
  `screeningStatus: blocked` with a durable screening record and audit verdict.
  Provider failure aborts creation with `503 COMPLIANCE_HOLD`.
- Standards-compliant EIP-681 URIs carry the numeric chain identity,
  checksummed token contract, checksummed recipient, and exact integer amount.
- Tenant-scoped `GET /api/v1/payments/:paymentId` returns capped
  confirmations, a `confirmed` boolean, safe partial/overpayment fields, and a
  lazy `expired` representation without mutating stored status; cross-tenant
  reads are indistinguishable from missing records.
- Derivation-index exhaustion fails closed with `503` without issuing an
  address or payment and without advancing the allocation counter.
- Assigned addresses are never reassigned; the address lifecycle is bound to
  the payment through the immutable `assignedPaymentId` unique index.

## Validation results

### Static, unit, coverage, and build gates

- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with zero warnings.
- `npm.cmd run validate`: passed formatting, zero-warning lint, strict type
  checking, 133 unit tests across 25 files, production build, Compose
  structural validation, and sanitized fail-closed process entrypoint checks.
- `npm.cmd run test:coverage`: passed every 80% threshold with 87.59%
  statements, 86.8% branches, 86.15% functions, and 87.59% lines.
- The payments router is excluded only from in-process unit coverage because
  every route is exercised against the built Docker API by the live Phase 05
  suite, matching the Phase 04 router exclusion precedent.
- `git diff --check`: passed.

### Live Docker and integration gates

- Rebuilt application images (api, watcher, processor, scheduler) from the
  finalized source and recreated the stack.
- Migration exited successfully with `databaseSchemaVersion: 2`; migration
  0001 and 0002 checksums remained stable because Phase 05 reused the existing
  persistence model without schema changes.
- `GET /health` returned `{"status":"ok"}` and `GET /ready` returned
  `{"status":"ready"}` through `127.0.0.1:3000`; `POST /api/v1/payments`
  without credentials returned `401`.
- Focused Phase 05 suite: 11 tests passed without skips, covering creation
  contract and audit durability, amount canonicalization and bounds, expiry
  clamping, idempotent replay and conflict, tenant isolation and scopes,
  disabled/unknown registry rejection, sanctioned-destination holds,
  exhaustion fail-closed, lazy expiry and capped confirmations, concurrent
  address uniqueness, and per-credential rate limiting.
- Full integration suite: 34 tests passed across 5 files without skips.

### Security and operational evidence

- The live suite proved unique public-only derivation, exactly-once idempotent
  creation under concurrency, tenant-isolated reads with identical 404
  envelopes, scope enforcement, fail-closed exhaustion, screening holds, and
  response redaction (no xpub/tpub, derivation index, wallet address identity,
  database, or RPC details in any payment response).
- API logs were reviewed for xpub/tpub material, merchant API keys, JWTs,
  scrypt hashes, passwords, provider URLs, and embedded credentials; none were
  exposed.
- `npm.cmd run verify:ci-negative-controls`: isolated type, test, and secret
  fixtures were all rejected.
- `npm.cmd audit --audit-level=high`: passed online with zero vulnerabilities.
- Pinned Gitleaks 8.28.0 scanned approximately 1.65 MB across the complete
  worktree and reported no leaks.
- No Phase 06 chain adapter, watcher, or event-ingestion implementation is
  included.

## Defects found and corrected

- Corrected the live suite's token deactivation step to use the audited
  force-disable path with the resource-bound confirmation literal, because
  earlier suite payments are intentionally open and normal deactivation must
  fail closed with `409` while they exist.
- Corrected the rate-limit probe to submit amounts that pass request
  validation so the creation quota is actually consumed; amounts rejected by
  the strict schema never reach the limiter.
- Dedicated a fresh merchant to the rate-limit test so the fixed 60-second
  window starts deterministically with the probe loop.
- Corrected the EIP-681 expectation to the checksummed token contract address
  that the registry stores and the URI builder renders.

## Completion decision

Every Phase 05 deliverable and applicable validation gate has passed. The phase
branch is eligible for its completion commit and merge into `main`. This does
not declare the gateway production-ready; Phases 06 through 12 and the final
release gates remain mandatory.
