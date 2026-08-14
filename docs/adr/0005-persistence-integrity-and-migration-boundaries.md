# ADR 0005: Persistence Integrity and Migration Boundaries

- Status: Accepted
- Date: 2026-08-14
- Decision owner: Repository owner through the accepted Phase 02 plan
- Relates to: `REQ-00`, `REQ-02`, `REQ-04`, `REQ-06`, `REQ-11`

## Context

Phase 02 establishes the database contracts that later phases use for tenant
isolation, money accounting, exactly-once event claims, reorg history,
compliance evidence, and merchant notifications. The specification requires
strict schemas, immutable financial evidence, append-only tamper-evident audit,
replica-set transactions, and explicit index deployment, but leaves the
concrete enforcement and migration mechanisms to the implementation.

Relying only on route validation, Mongoose's default permissive update
behavior, automatic index creation, or a process-local audit sequence would
leave correctness dependent on which code path performed a write. Those are
not acceptable boundaries for records that explain where money was observed
and how it was classified.

## Decision

### Schema and value contracts

All persisted models use strict-throw document and query behavior. Required
identifiers, enums, normalized addresses, hashes, and bounded integers are
validated at the schema boundary. Monetary values persist only as canonical
base-unit integer strings and are converted to native `bigint` through one
shared value module. No monetary schema path accepts JavaScript `number`.

MongoDB JSON Schema validators mirror the most important storage invariants in
production migrations so direct collection writes cannot silently bypass
amount formats, required identities, or audit immutability assumptions.

Historical identity fields are immutable. On-chain event identity and raw
payload are immutable; canonicality and claim state may change only through
the narrow repositories owned by their later phases. Reorged events are
retained. Chain and token records are soft-disabled and never hard-deleted.

### Audit integrity

Audit entries are chained per audit scope. A scope is either the platform or a
single merchant, preventing one tenant's activity from becoming a global write
bottleneck while retaining a deterministic verification boundary. Each entry
contains a monotonic sequence, previous hash, canonical payload, and SHA-256
entry hash.

An `AuditChainHead` document and the new `AuditLog` entry are advanced in the
same MongoDB transaction. Transaction conflicts are retried within a strict
bound. Unique indexes on scope/sequence and entry hash prevent forks or
duplicate placement. The application exposes append and verify operations
only; schema middleware rejects update, replacement, and delete operations.
Database roles used by runtime services must grant insert/read on audit logs
but deny update/delete in production. Backup retention and external archival
remain additional controls, not substitutes for the hash chain.

Canonical audit hashing uses an explicitly constructed, recursively stable
JSON representation with dates encoded as ISO-8601 strings and absent values
omitted. Hash version `1` is stored on every entry so a future encoding can be
introduced without invalidating history.

### Transaction capability

Correctness-critical helpers require an active MongoDB session and first prove
that the connected deployment is a writable replica set or sharded cluster
with logical-session support. They refuse to run against a standalone server
or an unverified topology. Transactions use majority write concern, snapshot
read concern, primary read preference, bounded retries for transient
transaction and unknown-commit-result labels, and no non-database side effects
inside retryable callbacks.

### Index and validator deployment

Runtime services keep `autoIndex: false` and never mutate production indexes at
startup. Versioned, forward-only migration modules declare collection
validators and indexes. A dedicated command acquires a database migration
lease, verifies the expected schema version, applies one migration at a time,
records its checksum and result, and then advances the compatibility version.

Indexes are created by explicit stable names. Potentially destructive changes
use expand/migrate/contract releases: add compatible fields/indexes first,
backfill and verify separately, then remove obsolete structures only in a later
owner-approved migration. Rollback means deploying the prior application while
the additive database shape remains; migrations do not automatically drop
financial data or indexes. Startup compatibility checks refuse application
versions outside the database version range they support.

TTL indexes are limited to disposable coordination/cache records: consumed
HMAC nonces, idempotency responses, compliance cache entries, admin sessions,
and completed webhook delivery retention where policy allows. Payments,
on-chain events, reorg records, reconciliation annotations, audit logs,
credentials, wallet allocation history, chain cursors, and observed blocks do
not expire automatically.

## Consequences

- Later phases receive explicit schemas and database indexes instead of
  inventing persistence contracts inside route or worker code.
- Audit append throughput is serialized per scope. This is intentional; scopes
  can process concurrently, and financial trace integrity takes precedence
  over maximizing write throughput.
- Direct database administration remains privileged and auditable. Application
  controls cannot protect against an operator with unrestricted database
  access, so production roles, backups, and external retention must enforce the
  documented boundary.
- A failed capability or compatibility check stops correctness-critical work
  instead of silently falling back to weaker behavior.
- Index and validator changes require an explicit operational step before a
  newly dependent application version is deployed.

## Verification

- Contract tests assert every required schema field, enum, immutable path,
  reference, index, and TTL policy.
- Live replica-set tests prove duplicate event identities, event claims,
  derivation allocations, and idempotency scope/key pairs fail atomically under
  concurrent writes.
- Transaction rollback tests leave no partial payment, wallet assignment, or
  audit state.
- Audit tests reject every application update/delete path, verify hash chains,
  and detect payload, order, previous-hash, and head tampering.
- Migration tests verify checksums, compatibility refusal, lease exclusion,
  idempotent re-execution, and additive rollback behavior.
