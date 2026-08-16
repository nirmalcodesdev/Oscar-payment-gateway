# Phase 06 Validation Evidence

- Branch: `phase/06-event-ingestion`
- Status: Complete
- Started: 2026-08-15
- Completed: 2026-08-16

## ADR review

Outcome: New ADRs required and accepted before dependent implementation.

Reviewed sources:

- `prompt.md` §3.3 internal ingestion endpoint, §3.4 confirmation inputs, §4
  data model additions, §5 chain adapter contract, §6 idempotency and
  concurrency, §8 background jobs, §9 security requirements, §15 deployment,
  and §16 known pitfalls.
- `phases.md` fixed architectural decisions and the Phase 06 deliverables and
  validation gate, plus the Phase 07 boundary (matching, state machine, and
  reorg recovery remain out of scope here).
- ADRs 0001 through 0008, especially ADR 0003 shared viem infrastructure,
  ADR 0004 process boundaries, ADR 0005 migration boundaries, and ADR 0007
  registry verification and disable safety.

Accepted for this phase:

- ADR 0009: chain-neutral adapter contract, factory selection by network
  family, shared provider extension, health/failover/disagreement behavior,
  polling with persisted cursor advancement behind durable writes, live
  registry refresh, and the decimal guard with admin-review resolution.
- ADR 0010: internal endpoint ownership and network boundary, versioned HMAC
  scheme with replay protection, persist-before-judgment persistence contract,
  deterministic event identity, BullMQ job contract, interpretation state via
  migration 0003, and balance-delta verification.

## Delivered contracts

- `src/domain/chain/chain-adapter.ts` defines the chain-neutral
  `ChainAdapter` port, `OnChainDepositEvent`, cursor/corroboration and
  balance-delta ports, and the `ChainDiscontinuityError` halt signal with no
  EVM-specific type in shared interfaces; `chain-adapter-factory.ts` selects
  the implementation by `networkFamily` and fails closed on unknown families.
- `evm-chain-adapter.ts` composes the Phase 04 shared viem provider layer
  (ADR 0003) into the EVM adapter: operator-distinct provider resolution,
  per-provider health with bounded timeouts, chain-ID verification, automatic
  failover, and independent-provider block-hash corroboration that discards
  the batch on disagreement instead of advancing the cursor.
- `watcher-service.ts` polls canonical Transfer logs per enabled chain from
  the persisted cursor, verifies parent-hash continuity (halting the chain on
  discontinuity for Phase 07 resolution), refreshes the enabled
  chain/token/recipient registry live without restart, applies the
  `EvmDecimalGuard`, submits verified deposits to the internal ingestion
  endpoint through the HMAC-signed client, and advances the Mongo cursor
  transactionally only after the ingestion endpoint acknowledges durable
  persistence.
- `EvmDecimalGuard` reads live `decimals()` through independent providers at
  watcher startup and on every registry refresh; mismatch, disagreement, or
  unavailability excludes the token from watching, degrades readiness, and
  writes an audit record for admin resolution without touching stored token
  configuration.
- `POST /api/v1/internal/on-chain-events` is mounted only in the `api`
  process, verifies the versioned HMAC-SHA256 signature over
  `${timestamp}\n${nonce}\n` plus the exact raw request bytes with
  `timingSafeEqual`, enforces the timestamp skew window, and atomically
  consumes nonces with TTL replay protection before any body interpretation.
- `event-ingestion-service.ts` derives the server-side
  `eventId = event_<sha256(chain|txHash|logIndex)>`, validates amounts as
  canonical base-unit integer strings, and performs the single atomic
  persist-before-judgment insert with unique `eventId` (duplicate-key
  collapses to `replayed`), then enqueues on every path.
- `event-queue.ts`/`event-worker.ts` run the deterministic BullMQ job
  (`jobId = eventId`, five attempts, jittered exponential backoff, failed set
  as the dead-letter record) with the effective Redis key namespace
  `${prefix}:event-interpretation`; the processor worker re-reads the event
  and registry from Mongo per job.
- `event-interpretation-service.ts` re-decodes the verbatim raw log (the raw
  capture is the source of truth over normalized fields), checks enabled
  chain/token, known recipient, and balance-delta policy for
  `balance_delta_required` tokens, and writes
  `accepted | rejected | review` with reason, `verifiedReceivedAmount`, and
  revision exactly once (migration 0003 extends the `on_chain_events`
  validator without altering migration 0001's index manifest checksum).
- `evm-balance-delta-reader.ts` corroborates recipient balance deltas
  through at least two independent providers for fee-on-transfer and
  rebasing verification, mapping disagreement or unavailability to `review`.

## Validation results

### Static, unit, coverage, and build gates

- `npm run typecheck`: passed.
- `npm run lint`: passed with zero warnings.
- `npm run validate`: passed formatting, zero-warning lint, strict type
  checking, 256 unit tests across 32 files, production build, Compose
  structural validation, and sanitized fail-closed process entrypoint checks.
- `npm run test:coverage`: passed every 80% threshold with 90.12% statements,
  85.45% branches, 88.4% functions, and 90.12% lines.
- Phase 06 adds 123 unit tests across seven new files: watcher service (21),
  EVM chain adapter (24), ingestion HMAC (24), interpretation service (20),
  ingestion service (12), decimal guard (13), balance-delta reader (9). The
  internal events router is excluded from in-process unit coverage because
  its full HMAC surface is exercised live by the Phase 06 integration suite,
  matching the Phase 04/05 router exclusion precedent.
- `git diff --check`: passed.

### Live Docker and integration gates

- Rebuilt application images (api, watcher, processor, scheduler,
  mongodb-migrate) from the finalized source and recreated the stack; all
  processes start and stay healthy.
- Migration exited successfully with `databaseSchemaVersion: 3`; migration
  0003 extends the `on_chain_events` collection validator via `collMod`
  without adding indexes, so migration 0001 and 0002 checksums remained
  stable.
- `GET /health` returned `{"status":"ok"}` and `GET /ready` returned
  `{"status":"ready"}` through `127.0.0.1:3000`; unsigned
  `POST /api/v1/internal/on-chain-events` returned `401` (fail closed).
- Focused Phase 06 suite: 35 tests passed without skips, covering HMAC
  current/previous keys, stale/future timestamps, duplicate nonces, tampered
  bodies, malformed headers, unknown key ids, schema-invalid and oversized
  payloads, verbatim persist-before-judgment for fake-contract,
  disabled-token, wrong-chain, malformed-log, and unknown-token events,
  durable cursor storage with conflict/discontinuity handling, interpretation
  outcomes including all balance-delta mappings and racing workers, and a
  live-queue gate proving duplicate ingestion collapses onto one prefixed
  BullMQ job delivered exactly once through the real worker.
- Full integration suite: 69 tests passed across 6 files without skips
  (phases 02 through 06 plus transaction helpers).

### Security and operational evidence

- The live suite proved the internal endpoint rejects every unsigned,
  wrongly keyed, replayed, tampered, and out-of-skew request before body
  interpretation, and that nonce replay protection rejects byte-for-byte
  replays with `401` while leaving exactly one persisted event.
- Startup and refresh decimal-guard tests prove a live `decimals()` mismatch
  or provider disagreement blocks watching and payment progression, degrades
  readiness, and alerts without corrupting amount comparisons.
- Watcher restart and provider-outage unit tests prove no block range is
  skipped and the cursor never advances before the ingestion endpoint
  acknowledges durable persistence; cursor conflicts and parent-hash
  discontinuities halt the chain and preserve history.
- API, watcher, processor, and scheduler logs were reviewed for HMAC
  secrets, admin JWT secrets, step-up secrets, database credentials, API
  keys, scrypt hashes, and xpub material; none were exposed, and no
  error-level logs were emitted during steady-state operation.
- `npm run verify:ci-negative-controls`: isolated type, test, and secret
  fixtures were all rejected.
- `npm audit --audit-level=high`: passed online with zero vulnerabilities.
- Pinned Gitleaks v8.28.0 scanned approximately 2.19 MB across the complete
  worktree and reported no leaks.
- No floating-point arithmetic exists in the money paths; amounts are
  validated as canonical base-unit integer strings and processed as `bigint`.

## Defects found and corrected

- Corrected strict-lint and formatting violations in the new integration
  suite: `expect.objectContaining` returns `any` (unsafe assignment under the
  repository ESLint contract) and was replaced with `toMatchObject` on plain
  objects plus a typed `issuePaths` helper following the Phase 05
  `trackPayment(body: unknown)` convention; `Array<T>` spellings were
  converted to `T[]`.
- Corrected dependency-lock drift: `package-lock.json` pinned top-level
  `ioredis` at 5.7.0 while the working tree required the 5.11.1 types that
  BullMQ 5.81.3 expects, so clean `npm ci` builds inside Docker failed type
  checking even though the stale local `node_modules` passed. `package.json`
  and the lockfile are now aligned on `ioredis` 5.11.1.
- Corrected the BullMQ queue construction: the queue and worker were built
  with the `${prefix}:event-interpretation` string as the queue name, which
  BullMQ rejects (`Queue name cannot contain :`), crashing the api and
  processor processes at construction. The bare
  `event-interpretation` name is now passed with the `prefix` queue option,
  producing the same `${prefix}:event-interpretation` Redis key namespace
  required by ADR 0010. A live integration gate now constructs the real
  queue and worker against Redis and asserts the namespace, the single
  collapsed job for duplicate ingestion, and exactly-once delivery.
- Corrected shared-Redis startup ordering: BullMQ resources constructed
  during runtime wiring initiate the shared ioredis connection before the
  lifecycle manager starts it, so `RedisResource.start()` aborted with
  "Redis is already connecting/connected". `start()` now initiates the
  connection only when idle, waits for an in-flight connection, and still
  fails closed when the connection ultimately fails.
- Corrected the transactional observed-block insert: Mongoose 8 refuses
  multi-document `create()` with a session unless `ordered: true` is set, so
  every cursor advance with new block headers failed. The insert is now
  explicitly ordered, which also preserves the designed abort-on-duplicate
  semantics when another instance commits the same block first.

## Completion decision

Every Phase 06 deliverable and applicable validation gate has passed. The
phase branch is eligible for its completion commit and merge into `main`.
This does not declare the gateway production-ready; Phases 07 through 12 and
the final release gates remain mandatory.
