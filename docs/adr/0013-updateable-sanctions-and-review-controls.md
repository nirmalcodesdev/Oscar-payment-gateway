# ADR 0013: Updateable Sanctions List, Screening Cache, and Review Decisions

- Status: Accepted
- Date: 2026-08-16
- Decision owner: Repository owner
- Relates to: `REQ-03D`, `REQ-10`, `REQ-11`

## Context

Phase 05 screens the payment destination at creation and Phase 07 screens the
observed sender before confirmation, both against an environment-configured
static list. `prompt.md` §10 requires a pluggable `SanctionsScreeningProvider`
with at least one working, updateable OFAC-list-based fallback checker
(provenance, freshness, deterministic normalization, integrity verification,
controlled list updates), short-TTL result caching that never approves on
stale data or provider outage, held payments surfaced to an admin
manual-review queue, audited role-restricted review decisions, and a
`COMPLIANCE.md` that does not present the software as legal certification.
The fixed compliance policy is fail-closed: errors, unknown results, and
blocked results hold payments; nothing defaults to approval.

## Decision

### Updateable managed sanctions list

- New collections back a managed list: `sanctions_lists` (one document per
  ingested list version with `listVersion`, `source`, `contentHash`,
  `entryCount`, `status: active | retired`, `ingestedAt`) and
  `sanctions_addresses` (one document per `{listId, normalizedAddress}`).
  A partial unique index on the active status makes "exactly one active
  list" a database guarantee. Retired lists are retained for audit; nothing
  is deleted.
- `UpdateableSanctionsListProvider` resolves the active managed list,
  normalizes addresses deterministically (lowercased EVM form, validated),
  and caches the address set in memory, refreshing on a bounded interval and
  immediately after an update. When no managed list exists it falls back to
  the environment static list (provenance `environment`), preserving
  out-of-the-box behavior; freshness enforcement applies only to managed
  lists because the operator opted into the update discipline by ingesting
  one.
- Freshness: a managed list older than `SCREENING_LIST_MAX_AGE_SEC`
  (default 604800) yields verdict `unavailable` for every screen — fail
  closed into holds, never silent approval. Phase 09's scheduled screening
  recheck and the documented manual/API update process keep lists fresh.
- Integrity: the ingest endpoint recomputes the SHA-256 over the canonical
  sorted unique normalized address set and requires the submitter's declared
  `contentSha256` to match, so transport corruption cannot silently alter
  the list. The hash, entry count, source, and version are stored as
  provenance on every list document.

### Controlled list updates

- `PUT /api/v1/admin/sanctions-list` (admin JWT required, rate-limited,
  strict Zod body) atomically retires the current active list and inserts
  the new version with its entries inside one transaction, then writes an
  append-only audit entry (before/after version, entry count, content hash,
  actor). Bodies are bounded (address count and size) so a single request
  cannot exhaust resources.
- After a committed update the provider refreshes its cache and held
  payments are re-screened against the new list: clearing results update
  `screeningStatus` through conditional version-guarded writes with audit;
  still-blocked or unavailable results keep the hold. Phase 09 adds the
  periodic sweep; Phase 08 provides the capability and invokes it on list
  updates.

### Screening cache and fail-closed behavior

- A `ScreeningService` wraps providers for all callers. A cached
  `ComplianceScreening` record is reused only while unexpired and only when
  the provider's current list version matches the cached one — a list
  change invalidates every cached verdict. Every provider call writes a
  `ComplianceScreening` record with provider, list version, risk, verdict,
  and a raw response kept out of default projections (`select: false`).
- Provider errors are sanitized before logging (no credentials, no raw
  payloads) and mapped to `unavailable`, which callers already treat as a
  hold. Malformed provider responses (missing verdict or unknown shape)
  map to `indeterminate` — also a hold. Cache expiry forces a fresh call;
  there is no path where a stale cache or an outage approves a payment.

### Holds queue and review decisions

- `GET /api/v1/admin/compliance/holds` surfaces non-terminal payments with
  `screeningStatus` `flagged`/`blocked`/`pending-at-gate` or open compliance
  annotations, with sanitized latest screening records and review history.
- `POST /api/v1/admin/compliance/holds/:paymentId/decision` records an
  append-only `ComplianceReview` decision (`release` or `block`) with an
  explicit reason and optional evidence, the reviewing admin as the actor,
  and an audit entry. The latest decision per payment is authoritative.
- The confirmation gate treats a payment as clear only when the fresh
  screen is clear, or when a non-clear screen is covered by an active
  `release` decision (recorded as a cleared-with-override transition with
  audit metadata naming the review). A `block` decision pins
  `screeningStatus: blocked`. No worker, admin action, retry, or race can
  reach a confirmed notification for a held payment without an authorized,
  audited decision; the Phase 07 automation hold remains an independent
  block.

### Documentation

- `COMPLIANCE.md` states the MSB/VASP classification uncertainty, sanctions
  obligations, FATF Travel Rule applicability, recordkeeping thresholds,
  that these hooks support but do not constitute a compliance program, and
  that qualified jurisdiction-specific legal review is required before
  operating with real funds.

## Consequences

- Operators can update sanctions lists without a redeploy, with integrity
  and provenance evidence for auditors.
- A stale managed list holds all payments — a deliberate fail-closed cost
  documented in operations guidance.
- Migration 0005 adds the three collections with validators and indexes and
  moves the database to schema version 5.
- Phase 09 webhook emission must respect both the screening hold and the
  review-decision state before sending confirmation notifications.
