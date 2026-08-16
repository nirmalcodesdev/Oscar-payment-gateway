# Phase 09 Validation Evidence

- Branch: `phase/09-operations-workflows`
- Status: Complete
- Started: 2026-08-16
- Completed: 2026-08-16

## ADR review

Outcome: New ADRs required and accepted before dependent implementation.

Reviewed sources:

- `prompt.md` §3.5 reconciliation surfacing, §8 background jobs and webhook
  delivery, §9 SSRF/rate-limit security, §11 audit discipline, and ADR 0002
  (webhook egress boundary with full SSRF controls).
- `phases.md` Phase 09 deliverables and validation gate, plus the Phase 10
  boundary (metrics/alert dashboards remain there).
- ADRs 0001 through 0013, especially ADR 0002 (egress exception), ADR 0005
  (versioned writes), ADR 0012 (automation holds that must gate
  confirmation notifications), and ADR 0013 (screening holds).

Accepted for this phase:

- ADR 0014: transactional webhook outbox keyed by
  `(paymentId, eventType, paymentVersion)`, platform versioned HMAC
  signing over timestamp/delivery id/exact bytes, BullMQ delivery with
  bounded jittered retries and a dead-letter set, scheduler crash-recovery
  sweep, audited admin replay, and the SSRF-hardened client (manual DNS
  resolution, public-only address pinning, no redirects, timeouts, and
  size-capped responses).
- ADR 0015: Redis-leased, database-idempotent scheduler jobs (expiry sweep
  through the legal state machine, confirmation recheck, stuck-payment
  detection, screening recheck, registry refresh, outbox sweep, retention)
  and the admin reconciliation API (discrepancy views, audited annotation
  resolution, audited webhook replay) with the audit log remaining
  read-only through application APIs.

## Delivered contracts

- `WebhookOutboxWriter` writes delivery rows **inside the transition
  transaction** for `payment.matched`, `payment.confirmed`,
  `payment.expired`, and `payment.failed`; the unique idempotency key
  collapses duplicate transitions onto exactly one row, and a rolled-back
  transaction leaves no row (proven by an injected post-write abort).
- The matching, confirmation, and scheduler expiry paths all emit through
  the outbox; confirmation rows only exist for gate-passing terminal
  confirmations (clear screening, no automation hold).
- `signedWebhookHeaders`/`signWebhookPayload` produce the documented
  four-header contract (`x-oscar-webhook-key-id`,
  `x-oscar-webhook-timestamp`, `x-oscar-delivery-id`,
  `x-oscar-webhook-signature`) with platform versioned secrets and
  paired-key configuration validation mirroring the ingestion scheme.
- `WebhookDeliveryClient` revalidates the destination, resolves DNS
  manually, blocks every non-public address family (loopback, private,
  link-local/metadata, CGNAT, unique-local, multicast, IPv4-mapped),
  dials the validated IP while preserving Host/SNI, never follows
  redirects, enforces a hard timeout, and caps response reads. A
  non-production-only test allowlist seam exists for local receivers and
  throws if constructed in production.
- `WebhookDeliveryQueue`/`WebhookDeliveryWorkerResource` deliver with
  `jobId = deliveryId` (duplicate enqueues collapse), byte-stable payload
  serialization so every retry signs identical bytes, exactly one failure
  record per BullMQ attempt, `dead_letter` on exhaustion, completion
  expiry for retention, and an immediate enqueue plus a scheduler sweep
  for crash recovery.
- `SchedulerService` runs the seven jobs with `JobLease` coordination
  (SET NX PX; leases expire naturally rather than being released, so a
  takeover can never be un-leased). The expiry sweep uses the same legal
  state-machine guard, audit entry, and outbox write as the event-driven
  path; the outbox sweep re-enqueues due pending rows; retention stamps
  completion expiry.
- `ReconciliationService` + `createReconciliationRouter` expose
  `GET /api/v1/admin/reconciliation` (orphan events, open annotations,
  stale payments, compliance holds, reorg effects, webhook dead letters),
  audited annotation resolution with conflict semantics, and audited
  webhook replay with delivered-conflict rejection.
- Configuration adds the webhook signing/timeout/attempt/retention keys
  and the scheduler cadence/lease family; compose, `.env.example`, and the
  test environment carry them.

## Validation results

### Static, unit, coverage, and build gates

- `npm run typecheck` and `npm run lint`: passed with zero warnings.
- `npm run validate`: passed formatting, strict type checking, 285 unit
  tests across 37 files, production build, Compose validation, and
  entrypoint checks.
- `npm run test:coverage`: 90.26% statements, 86.86% branches, 89.74%
  functions — every 80% threshold met. The compliance and reconciliation
  routers join the established live-exercised router exclusions; the
  reconciliation router is exercised against the live API by this phase's
  suite (401 unauthenticated, overview shape, validation envelopes, 404
  replay).
- Phase 09 adds 14 unit tests: signing determinism/tampering/rotation and
  header construction; the address blocklist table; URL validation
  including production HTTPS enforcement, credential rejection, loopback
  and metadata blocking, private-DNS resolution blocking, unresolvable
  hostnames, timeouts, and the production refusal of test allowlists.
- `git diff --check`: passed.

### Live Docker and integration gates

- The stack rebuilt and started healthy with the scheduler running its
  job resource; all four processes start with the new required webhook
  configuration.
- Focused Phase 09 suite: 12 tests passed without skips, covering the
  outbox boundary matrix (matched/confirmed/failed/expired rows; held and
  rolled-back paths leave none; duplicate transitions collapse to one
  row), end-to-end delivery to a live local receiver with verified HMAC
  signature headers over the exact bytes and duplicate-enqueue collapse
  to a single request, dead-lettering after bounded attempts with the
  failing response code recorded, audited replay with delivered-conflict
  rejection, redirect and oversized-response failure handling, the expiry
  sweep's legal transition with audit/outbox and idempotence, single-run
  lease semantics across concurrent schedulers, deterministic stale
  annotation, the outbox crash-recovery sweep, reconciliation views with
  audited annotation resolution and conflict/not-found semantics, live
  router auth and validation, and byte-stable serialization.
- Full integration suite: 115 tests passed across 9 files without skips.

### Security and operational evidence

- SSRF: loopback, private ranges, cloud metadata, CGNAT, unique-local,
  IPv4-mapped, and private-resolving hostnames are all rejected; redirects
  are never followed; production enforces HTTPS; test destination
  allowlists cannot be constructed in production.
- No webhook is emitted for rolled-back, held, blocked, or
  automation-held state; notification loss requires losing a committed
  transaction, and crash-lost enqueues are recovered by the sweep.
- Gitleaks v8.28.0 scanned ~2.87 MB with no leaks; `npm audit` reported
  zero vulnerabilities; negative-control fixtures were rejected; service
  logs contain no signing secrets, credentials, or bearer tokens.

## Defects found and corrected

- Corrected the delivery worker to record exactly one failure per BullMQ
  attempt: the non-2xx branch and the catch clause both recorded, double
  incrementing the attempt counter (surfaced as attempts=4 after two
  real attempts).
- Corrected the IPv6 blocklist, which compared a single hex digit against
  a 16-bit prefix range and missed `fc00::/7` (surfaced by the blocklist
  unit table).
- Corrected the redirect test to exercise the allowlisted client path and
  to strip the URL path from allowlist entries (the entry previously
  included `/hook`, silently failing the allowlist match).
- Hardened the integration suite: delivery fixtures refresh the merchant
  webhook URL per test (a stale URL from a closed receiver previously
  dead-lettered with no response code) and upsert complete merchant
  documents (a partial upsert collided on the null-email unique index);
  payment fixtures run on a namespaced chain so the live scheduler's
  confirmation recheck observes them as unavailable and stays a no-op;
  immutable fixture fields (`ingestedAt`) are written at the driver
  level; the held fixture increments rather than sets the payment
  version.

## Completion decision

Every Phase 09 deliverable and applicable validation gate has passed. The
phase branch is eligible for its completion commit and merge into `main`.
This does not declare the gateway production-ready; Phases 10 through 12
and the final release gates remain mandatory.
