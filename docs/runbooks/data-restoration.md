# Runbook: Data restoration, backup, RPO/RTO

## Backup strategy (MongoDB — system of record)

- Continuous: replica-set oplog enables point-in-time recovery.
- Scheduled: `mongodump --oplog --gzip` (or filesystem snapshots) at least
  hourly to encrypted storage (at-rest encryption + restricted access).
- Retain: hot 7 days, encrypted archive per regulatory recordkeeping
  guidance (see COMPLIANCE.md; audit retention is indefinite — never prune
  `audit_logs`/`audit_chain_heads`).

## Restore procedure (into an isolated environment first)

1. Provision an isolated replica set + encrypted volume.
2. `mongorestore --oplogReplay --gzip` the dump.
3. Verify: `schema_metadata` version matches the deployed code's catalog;
   run migrations if the target code is newer (`npm run migrate`).
4. Verify integrity: audit chain verification job over `audit_logs`
   ordered by scope/sequence — any break is a P1.
5. Only after verification may restored data serve traffic.

## Redis durability expectations

- Redis holds delivery coordination only (queues, locks, rate limits).
- AOF everysec: at most ~1s of queue-state loss is acceptable; the
  scheduler sweeps and outbox sweeps re-enqueue from MongoDB, so no
  notification or transition is ever lost with Redis alone.
- Never restore Redis from stale backups; flush and let Mongo rebuild.

## RPO / RTO targets (measured, not assumed — see phase evidence)

- RPO (MongoDB): ≤ 5 minutes with hourly dumps + oplog replay to the last
  oplog entry; measured during the Phase 11 restore drill.
- RTO (payment services): ≤ 30 minutes from backup availability to
  verified serving (restore + migrate + verify + roll processes); measured
  during the drill.

## Recovery ownership

- Primary: infrastructure on-call (datastore restore).
- Verification sign-off: engineering lead (schema + audit chain).
- Go/no-go: engineering lead + finance owner when payments were in flight.

## Escalation

Any restore used for real traffic requires the incident commander's
sign-off; suspected corruption → incident-response runbook.
