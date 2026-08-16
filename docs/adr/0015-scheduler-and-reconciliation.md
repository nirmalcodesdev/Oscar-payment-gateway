# ADR 0015: Scheduled Jobs, Leader Coordination, and Admin Reconciliation

- Status: Accepted
- Date: 2026-08-16
- Decision owner: Repository owner
- Relates to: `REQ-03E`, `REQ-08`, `REQ-11`

## Context

`prompt.md` §8 requires scheduled jobs beyond the watcher and processor:
expiry sweep, confirmation re-check, stuck-payment detection, screening
re-check, registry refresh, and retention maintenance. §3.5 requires the
admin reconciliation view to surface — never hide — orphaned deposits, stale
payments, compliance holds, reorg effects, and (per Phase 09) webhook
dead-letter entries, with every admin action audited. The fixed decisions
require Redis-backed leader coordination while database conditional writes
remain the correctness boundary, and multi-replica schedulers must produce
one effective result.

## Decision

### Scheduler jobs and leader coordination

- The `scheduler` process runs a job runner with one periodic job per
  concern. Each job execution is guarded by a Redis lease
  (`${QUEUE_PREFIX}:job-lease:<job>`, SET NX PX with a random token and
  token-checked release, renewed per execution): only the lease holder
  executes. Leases only prevent duplicate work; every job is also idempotent
  at the database layer (conditional transitions, deterministic enqueues by
  id, annotation deduplication), so a lease expiry mid-run or a split brain
  cannot double-apply effects.
- Jobs:
  - **Expiry sweep**: transitions `pending` payments past `expiresAt` to
    `expired` through the same legal state-machine path with audit — never a
    raw update. Payments with partial claims are annotated for refund
    review.
  - **Confirmation recheck**: re-enqueues the deterministic confirmation job
    for `matched`/`confirming` payments whose job appears lost, so a missed
    or delayed event cannot strand a payment (jobId dedupe collapses).
  - **Stuck-payment detection**: `matched`/`confirming` payments older than
    a configurable multiple of their expected confirmation time get an open
    `stale` annotation and an error log — surfaced, not hidden.
  - **Screening recheck**: re-screens held payments against the current
    sanctions list version, clearing holds whose verdicts changed (through
    conditional writes) and leaving others held.
  - **Registry refresh**: refreshes the enabled-registry snapshot and the
    recipients set used by scheduled checks, converging with the watcher's
    live refresh.
  - **Webhook outbox sweep**: re-enqueues due `pending` deliveries whose
    enqueue was lost (crash recovery for ADR 0014).
  - **Retention maintenance**: verifies TTL-driven cleanup and marks
    delivered webhook rows for expiry after the configured retention.
- Job intervals are configured (`SCHEDULER_*_INTERVAL_SEC` family) with
  bounded ranges; a single `SCHEDULER_LEADER_TTL_SEC` governs lease
  duration.

### Admin reconciliation

- `GET /api/v1/admin/reconciliation` aggregates read-only views:
  orphan events (accepted, canonical, unclaimed, past a grace window),
  open `late`/`partial`/`excess` annotations, stale `matched`/`confirming`
  payments, open compliance holds, unresolved reorg effects (open `reorg`
  annotations plus automation-held payments), and webhook dead-letter
  entries with their last response codes.
- `POST /api/v1/admin/reconciliation/annotations/:annotationId/resolve`
  closes an annotation with a required note, the admin as actor, and an
  audit entry. Annotations are append-only records; resolving flips only
  the status fields through a conditional write. The `AuditLog` collection
  itself stays read-only through every application API.
- `POST /api/v1/admin/webhooks/:deliveryId/replay` re-enqueues a
  dead-lettered or stuck delivery after resetting it, audited (ADR 0014).
- All reconciliation endpoints are admin-JWT only and rate limited.

## Consequences

- Lazy expiry alone no longer gates merchant-side automation: the sweep
  makes terminal states proactive.
- Operational recovery (stuck payments, lost enqueues, dead letters) is
  queryable and actionable through audited endpoints rather than manual
  database surgery.
- Phase 10 will add metrics/alerts on sweep outcomes and queue depths.
