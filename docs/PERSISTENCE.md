# Persistence Operations

Phase 02 establishes the MongoDB contracts and deployment rules used by later
payment, watcher, compliance, and webhook phases. MongoDB must be a replica set
or sharded cluster with logical sessions. A standalone server is unsupported
for correctness-critical operations.

## Runtime and migration identities

Migration and runtime processes must use different database identities:

- The migration identity needs `readWrite` and `dbAdmin` on the Oscar database
  so it can create collections and indexes and apply `collMod` validators.
- Runtime identities need only the data operations owned by each service. They
  must not receive `dbAdmin`, migration-ledger write, or index-management
  privileges.
- Production audit-writer roles should receive insert/read access to
  `audit_logs`, while update/delete remain denied. Operational verification and
  archival identities should be read-only.

Local Compose uses fixed development-only `oscar_migrate` and `oscar_app`
identities to exercise this separation. Those credentials must never be reused
outside local development.

## Deployment order

1. Back up MongoDB and verify restore readiness before a schema change.
2. Deploy the application image containing both the next migration catalog and
   code that remains compatible with the current database version.
3. Run `npm run migrate` once with the migration identity. In Compose,
   `mongodb-migrate` is the one-shot equivalent.
4. Verify the migration exit code, `schema_metadata` version/checksum, expected
   named indexes, and collection validators.
5. Start runtime services. Each MongoDB resource checks the database schema
   compatibility range and fails startup when it is too old or too new.
6. Remove migration credentials from the runtime environment. Do not mount
   them into API, watcher, processor, or scheduler containers.

Runtime services keep Mongoose `autoIndex: false`; application startup never
creates, changes, or drops indexes.

## Migration behavior

Migrations are versioned, checksummed, forward-only, and protected by a
database lease. A recorded migration with a different name or checksum is a
hard failure. Re-running an already applied catalog is idempotent and does not
reapply it.

Schema evolution follows expand, migrate, contract:

1. Expand with optional fields, additive validators, and new named indexes.
2. Deploy code that can read old and new shapes.
3. Backfill in bounded, resumable batches with explicit reconciliation.
4. Verify counts, invariants, and application compatibility.
5. Contract obsolete shapes only in a later reviewed migration.

Migration code must never automatically delete payments, raw on-chain events,
wallet allocation history, audit logs, reorg records, or reconciliation
records. TTL indexes are restricted to explicitly disposable cache or
coordination documents.

## Rollback

Database migrations are additive unless a separately approved contract
migration says otherwise. If an application rollout fails:

1. Stop the affected new application deployment.
2. Keep the migrated database shape in place.
3. Redeploy the previous application version after confirming its declared
   compatibility range includes the current schema version.
4. Do not drop a new index or field during an incident unless its measured
   operational impact requires it and an owner-approved recovery procedure
   identifies all affected query paths.
5. Record the rollback and any manual database action in operational audit
   evidence.

Never edit `schema_metadata` to make incompatible code start. Correct the
application or ship a reviewed forward migration.

## Verification commands

```text
npm run build
npm run migrate
npm run test:integration
docker compose ps -a
docker compose logs mongodb-migrate
```

The integration suite proves migration idempotence and compatibility refusal,
database-level amount validation, concurrent uniqueness boundaries,
append-only audit behavior, tamper detection, and multi-document rollback.
