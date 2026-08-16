# Phase 08 Validation Evidence

- Branch: `phase/08-compliance-controls`
- Status: Complete
- Started: 2026-08-16
- Completed: 2026-08-16

## ADR review

Outcome: New ADR required and accepted before dependent implementation.

Reviewed sources:

- `prompt.md` §10 compliance layer (hooks, not legal certification), §3.4
  confirmation-gate compliance checks, §4 `ComplianceScreening` caching, §11
  audit redaction, and §16 pitfalls on compliance provider failure.
- `phases.md` fixed compliance policy (provider errors, unknown results, and
  blocked results hold; nothing defaults to approval) and the Phase 08
  deliverables and validation gate, plus the Phase 09 boundary for scheduled
  re-screening sweeps.
- ADRs 0001 through 0012, especially ADR 0005 migration boundaries, ADR 0011
  compliance hold representation at the confirmation gate, and ADR 0012
  automation holds.

Accepted for this phase:

- ADR 0013: updateable managed sanctions list with provenance, freshness
  fail-closed enforcement, canonical integrity hashing, and atomic audited
  replacement; screening facade with short-TTL cache invalidated by list
  version; held-payment review queue with append-only audited release/block
  decisions honored by the confirmation gate; `COMPLIANCE.md` scope statement.

## Delivered contracts

- Migration 0005 adds `sanctions_lists` (partial unique index enforcing
  exactly one active list), `sanctions_addresses`, and `compliance_reviews`
  with strict validators, and extends the `compliance_screenings` validator
  with the persisted `verdict` field (optional for legacy records). The
  database settles at schema version 5.
- `UpdateableSanctionsListProvider` resolves the active managed list with a
  bounded in-memory refresh and immediate invalidation after updates,
  normalizes addresses deterministically to lowercase EVM form, carries
  provenance (list id, version, source, content hash) in every raw response,
  falls back to the environment static list only while no managed list
  exists, and returns `unavailable` for a stale managed list
  (`SCREENING_LIST_MAX_AGE_SEC`) or a database read failure — fail closed.
- `PUT /api/v1/admin/compliance/sanctions-list` (admin JWT, rate limited,
  strict bounded Zod body) recomputes the canonical SHA-256 over the sorted
  unique normalized addresses and rejects a mismatch, then atomically
  retires the previous active list and inserts the new version with entries
  and an append-only audit entry inside one transaction. Retired lists are
  retained. After a committed update the provider cache is invalidated and
  held payments are re-screened: clearing results update `screeningStatus`
  through conditional version-guarded writes; still-held results keep the
  hold.
- `ScreeningService` centralizes screening for the payment-creation and
  confirmation paths: an unexpired `ComplianceScreening` verdict is reused
  only when the provider's active list version still matches (a list update
  invalidates every cached verdict); provider failures are sanitized (no
  payloads or credentials in logs) and mapped to `unavailable`; malformed
  provider results map to `indeterminate`; every provider call writes a
  record with provider, verdict, risk, list version, and a raw response
  excluded from default projections. The TTL index removes expired records,
  forcing fresh calls.
- `GET /api/v1/admin/compliance/holds` surfaces non-terminal held payments
  with merchant, chain, amount, status, screening status, hold age, and the
  latest review decision.
- `POST /api/v1/admin/compliance/holds/:paymentId/decision` records an
  append-only `ComplianceReview` (`release` or `block`) with an explicit
  reason and optional evidence, the reviewing admin as actor, and an audit
  entry; a `block` decision additionally pins `screeningStatus: blocked`.
- The confirmation gate honors decisions before confirming: an active
  `block` holds the payment unconditionally (annotated, never confirmed,
  never webhook-eligible); a non-clear fresh screen with an active `release`
  clears with an audited `payment_compliance_override_released` transition
  naming the review; without a release, `blocked`/`flagged`/`unavailable`/
  `indeterminate` all hold. No worker, admin action, retry, or race path can
  reach a confirmed notification for a held payment without an authorized
  audited decision.
- `COMPLIANCE.md` states the MSB/VASP classification uncertainty, sanctions
  scope of the fallback checker, FATF Travel Rule gaps, recordkeeping
  boundaries, the hooks-versus-program distinction, and the requirement for
  qualified jurisdiction-specific legal counsel.
- Configuration adds `SCREENING_LIST_MAX_AGE_SEC` (default 604800).

## Validation results

### Static, unit, coverage, and build gates

- `npm run typecheck`: passed.
- `npm run lint`: passed with zero warnings.
- `npm run validate`: passed formatting, zero-warning lint, strict type
  checking, 283 unit tests across 35 files, production build, Compose
  structural validation, and sanitized fail-closed entrypoint checks.
- `npm run test:coverage`: passed every 80% threshold with 83.88% statements,
  87.87% branches, 88.6% functions, and 83.88% lines.
- Phase 08 adds 12 unit tests across two new files: the updateable provider
  (environment fallback, managed-list matching with deterministic
  normalization, stale fail-closed, malformed addresses, invalidation-driven
  reload, active-version exposure) and the screening facade (cache hit, TTL
  expiry, list-version invalidation, sanitized provider failure, malformed
  result mapping, per-call record writing).
- `git diff --check`: passed.

### Live Docker and integration gates

- Rebuilt all application images; the stack starts healthy and the migration
  settles the recreated database at `databaseSchemaVersion: 5`.
- Focused Phase 08 suite: 14 tests passed without skips, covering
  deterministic order-insensitive content hashing, managed-list activation
  with entries and audit, atomic replacement with history retention and
  immediate provider cutover, integrity-hash mismatch rejection without
  state change, malformed/empty list rejection, stale-list fail-closed
  screening, raw-response projection exclusion, cache reuse plus
  list-change invalidation, sanctioned-sender holds with retry-stability,
  the holds queue view, audited release unblocking the gate with override
  audit entries, block-decision pinning, unknown-payment rejection, and the
  live router (401 unauthenticated, 400 validation envelopes, audited
  ingestion through the admin endpoint).
- Full integration suite: 103 tests passed across 8 files without skips.

### Security and operational evidence

- No held payment can confirm without an authorized audited release: the
  gate holds on every non-clear verdict and on active block decisions, and
  retries re-evaluate fresh screens against the current list version.
- Stale cache, provider outage, malformed responses, and stale lists all
  fail closed into holds; no path treats them as approval.
- Service logs contain no HMAC/JWT secrets, no credentials, no raw provider
  payloads, and no bearer tokens; the only error-level entries during the
  suites were the intentionally exercised derivation-exhaustion paths from
  the Phase 05 suite.
- `npm run verify:ci-negative-controls`: isolated type, test, and secret
  fixtures were all rejected.
- `npm audit --audit-level=high`: passed online with zero vulnerabilities.
- Pinned Gitleaks v8.28.0 scanned approximately 2.78 MB across the complete
  worktree and reported no leaks.

## Defects found and corrected

- Corrected the review-decision schema: `evidence` was built from the
  always-required immutable-string helper, rejecting optional-evidence
  decisions; it is now an optional immutable field.
- Corrected the confirmation gate to honor an authorized `block` decision
  unconditionally — previously a later clear fresh screen could confirm a
  payment an administrator had explicitly blocked (surfaced by the
  block-pinning integration test).
- Corrected the content-hash helper to deduplicate the canonical address
  set, matching the ingest service's normalization, so submitter and server
  always compute identical digests.
- Hardened the integration suites for hermeticity: the Phase 08 suite clears
  sanctions lists, entries, screening records, and reviews before running;
  the Phase 07 suite clears screening records so unexpired cross-run cache
  entries cannot leak into scripted screening assertions; the stale-list
  fixture now writes at the driver level because `ingestedAt` is
  intentionally immutable at the mongoose layer.
- Recreated the development database after adding the Phase 08 schemas:
  migration 0001's manifest is derived from the live model definitions, so
  schema additions rotate its computed checksum and existing databases must
  be re-created (fresh databases are unaffected, and migration 0005 already
  tolerates pre-created collections). This dynamic-manifest characteristic
  is recorded here for future phases.

## Completion decision

Every Phase 08 deliverable and applicable validation gate has passed. The
phase branch is eligible for its completion commit and merge into `main`.
This does not declare the gateway production-ready; Phases 09 through 12 and
the final release gates remain mandatory.
