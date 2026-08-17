# ADR 0017: Managed Sanctions-List Retirement and Cache Reset

- Status: Accepted
- Date: 2026-08-16
- Decision owner: Repository owner
- Relates to: ADR 0013, `REQ-10`

## Context

ADR 0013 introduced the updateable managed sanctions list: exactly one active list
(partial unique index), an in-process provider cache refreshed on a bounded interval
and immediately after an update, and fail-closed screening. But ADR 0013 defined no
way to move from a managed list back to "no managed list" (the environment static
list fallback):

- Retiring a list has no administrative endpoint; `provider.invalidate()` is only
  reachable in-process, after an ingest.
- The API process is the only process whose `UpdateableSanctionsListProvider`
  instance is shared with both the screening and compliance paths. Its bounded
  in-memory cache has no external invalidation trigger.
- Integration verification observed an intermittent failure caused by exactly this
  gap: a compliance-router test ingests a managed list through the live API, the
  API cache keeps serving it after the test's direct-database cleanup, and a
  subsequent test file that asserts the static-list fallback saw the stale managed
  list. Database cleanup alone cannot clear the API's process memory.

The defect is a hermeticity failure of the verification environment, not a
production safety hazard: a stale managed list still screens fail-closed, and a
cleared database still yields the static fallback on the next in-process refresh.
The gap is that no durable control exists to force that refresh.

## Decision

Add a development-gated, authenticated, audited administration control that
retires the active managed sanctions list and resets the in-process provider
cache, restoring the environment static-list fallback:

- `DELETE /api/v1/admin/compliance/sanctions-list/active` (admin JWT required,
  rate limited) atomically retires the active list (if any) with the same
  append-only audit discipline as ingest, then invalidates the shared provider
  cache.
- When no active list exists the operation is a no-op with a `200` and the same
  audit trail (`before.listVersion: undefined`).
- The endpoint is compiled out of non-development builds: when `NODE_ENV` is not
  `development`, the router does not register the route and requests yield the
  standard `404` envelope. This keeps the control out of test and production
  deployments by construction, while the `development` gate matches how the Compose
  application stack and the integration suites run.
- The static-list fallback remains read-only configuration; a successful reset does
  not mutate `SANCTIONS_STATIC_LIST`.

## Consequences

- Verification environments and operators running in `development` can
  deterministically restore the static fallback without restarting the API process,
  closing the in-memory-cache contamination window.
- Production keeps the ADR 0013 discipline: the route does not exist outside
  `development`, so there is no production control surface expansion.
- Retirement audit entries reuse the `sanctions_list_updated` action with
  `after.listVersion: null` for the successor, keeping the append-only
  `SanctionsList` history intact (retired lists are never deleted).
