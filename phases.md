# Oscar Payment Gateway Implementation Phases

## 1. Purpose and execution contract

This document turns every requirement in `prompt.md` into an ordered,
test-gated implementation plan. It is not permission to defer a hard
requirement indefinitely. A phase is complete only when its implementation,
tests, security review, documentation, and operational acceptance criteria all
pass on its dedicated branch.

### Specification completeness prerequisite (`SPEC-00`) - Resolved

Accepted ADR 0001 records the repository owner's decision that the current
`prompt.md` supersedes every prior or unavailable brief and is the complete
authoritative specification for Oscar Payment Gateway v1. References in the
prompt to an "original brief" introduce no unlisted v1 requirement.

Phase 01 may begin. Phase 12 must retain ADR 0001 as release evidence and verify
all requirements explicitly present in `prompt.md`. An earlier brief discovered
later changes nothing unless the owner accepts a new ADR and the traceability,
implementation, tests, and release evidence are updated through the normal
phase workflow.

The implementation priority is:

1. Correct money accounting and exactly-once crediting.
2. Tenant isolation, security, and fail-closed behavior.
3. Compliance hooks and auditable manual review.
4. Observability and operational recovery.
5. Clear structure and maintainability.
6. Optimization after correctness is demonstrated.

## 2. Fixed architectural decisions

These decisions remove ambiguity before implementation begins:

- Runtime: a supported Node.js LTS release, Express, and strict TypeScript.
- Persistence: Mongoose on MongoDB configured as a replica set in development,
  test, staging, and production-like environments.
- Chain library: viem only, using native `bigint` at computation boundaries.
- Money representation: canonical base-unit integer strings in persistence and
  API contracts; native `bigint` only during arithmetic. JavaScript `number`
  and floating point are prohibited for money.
- Work queues: BullMQ backed by Redis, with deterministic job IDs, bounded
  retries, exponential backoff with jitter, and dead-letter handling.
- Distributed coordination: Redis-backed locks and leader election, while
  database uniqueness and conditional writes remain the final correctness
  boundary.
- Deposit allocation: Option A, one unique EVM deposit address per payment,
  derived only from a merchant-controlled extended public key. The service
  never receives or holds private signing material.
- Merchant onboarding: admin-approved by default. API keys are shown once,
  stored only as salted hashes with non-sensitive lookup prefixes, scoped, and
  rotatable.
- Admin authentication: short-lived JWT access tokens with role-based access,
  rotating refresh tokens, revocation, and documented key rotation.
- Late-payment policy: persist the event and route payments received after
  expiry into manual reconciliation during a configurable grace window. Do not
  auto-credit late payments and never silently discard them.
- Underpayment policy: accumulate and expose partial base-unit amounts while
  the payment is open; do not match until the configured requirement is met.
  Expired partial payments are held for manual refund/reconciliation review.
- Overpayment policy: permit an exact-address match within an operator-defined
  policy, record expected, received, and excess amounts, and surface it for
  reconciliation. No excess is hidden.
- Compliance policy: screening provider errors, unknown results, and blocked
  results place the payment on hold. They never default to approval.
- Chain registry policy: chains and tokens are admin-curated, created disabled,
  verified against independent RPC providers and live contracts, and only
  soft-disabled.
- RPC ownership policy: infrastructure endpoints remain operator-configured.
  Merchant webhook URLs are the narrow client-configured egress exception and
  must use the dedicated SSRF controls accepted in ADR 0002.
- viem ownership policy: Phase 04 introduces the shared low-level RPC and
  contract-verification infrastructure; Phase 06 composes it into the EVM
  adapter without creating a second client stack, as accepted in ADR 0003.
- Webhook policy: emit status notifications only after durable state commits;
  confirmation notifications require confirmation depth, canonicality, and a
  clear compliance result. Delivery is at least once and signed.
- Deep-reorg policy: a reorg deeper than a payment's snapshotted confirmation
  requirement is a finality-assumption violation. Preserve the historical
  confirmed transition, mark the payment and event for incident reconciliation,
  stop automated downstream action, create immutable incident/audit records,
  and page P1. Any corrective business action requires an authorized, audited
  manual decision; do not silently rewrite terminal history.

## 3. Mandatory branch, commit, and merge gate

For each phase `NN`:

1. Update local `main` and verify it is healthy.
2. Create `phase/NN-short-description` from `main`.
3. Implement only the phase scope and required prerequisites.
4. Run the phase test matrix and the full regression suite available so far.
5. Review security, tenant boundaries, amount handling, idempotency, logging,
   error responses, and operational failure behavior.
6. Commit the completed phase with a concise imperative message that contains
   no tool references, generated-content wording, personal name, or author
   attribution.
7. Merge into `main` only after all implementation and validation gates pass.
8. Tag or record the validation evidence where the repository workflow can
   retain it.

No partial phase may be called complete or merged. Emergency corrections get
their own narrowly scoped branch and the same validation discipline.

## Phase 01: Repository foundation and architecture

Branch: `phase/01-foundation`

Deliverables:

- Create the Node.js/Express/TypeScript project with strict compiler settings,
  linting, formatting, unit/integration test runners, exact dependency
  versions, and a committed lockfile.
- Establish independently runnable entry points for API, watcher, processor,
  and scheduler processes with shared domain/application/infrastructure
  modules and explicit dependency injection.
- Define configuration validation with strict schemas. Reject startup when
  required settings are missing or unsafe for the selected environment.
- Add `.gitignore`, `.env.example`, editor settings, license decision, and
  baseline README with the non-custodial model and v1 exclusions: fiat ramps,
  card processing, custody, fiat settlement/conversion, and tax reporting.
- Add Docker development services for a MongoDB replica set and Redis, plus
  health checks and deterministic startup instructions.
- Add CI gates for type checking, linting, tests, build, dependency audit,
  secret scanning, and software composition analysis.
- Write an architecture decision record for process boundaries, Option A xpub
  address derivation, viem, consistency boundaries, and threat assumptions.
- Establish consistent error envelopes and process-level graceful shutdown.

Validation gate:

- Clean install from the lockfile, type check, lint, unit tests, production
  build, and container startup all pass.
- MongoDB transactions are proven to work against the local replica set.
- Every process starts, reports lifecycle status, and shuts down cleanly.
- CI rejects a representative type error, test failure, and committed secret.

Suggested commit: `Establish service foundation and architecture`

## Phase 02: Persistence, invariants, and audit foundation

Branch: `phase/02-persistence-invariants`

Deliverables:

- Implement strict Mongoose schemas for Merchant, MerchantCredential,
  MerchantWallet/xpub metadata, WalletAddress, Payment, Chain, Token,
  OnChainEvent, ChainCursor/observed blocks, ReorgRecord, AuditLog,
  IdempotencyKey, ComplianceScreening, WebhookDelivery, consumed HMAC nonce,
  admin identity/session, and reconciliation annotations.
- Define the required `Payment` contract explicitly: `amount` and optional
  `amountReceived` as base-unit integer strings, `underpaymentFlag`,
  `overpaymentFlag`, optimistic `version` incremented on every update,
  immutable `walletAddressId`, snapshotted `requiredConfirmations`, and
  `screeningStatus` limited to `clear | flagged | blocked | pending`, together
  with all other applicable fields explicitly specified in `prompt.md`.
- Define the required `OnChainEvent` contract explicitly: unique `eventId`,
  verbatim `rawEvent`, optional unique event claim `matchedPaymentId`, immutable
  chain/contract/transaction/log identity, `canonical`, and optional
  `confirmationsAtIngest`, together with all other applicable fields explicitly
  specified in `prompt.md`.
- Define `ReorgRecord` with `chain`, `fromBlock`, `toBlock`, `detectedAt`,
  `orphanedTxHashes`, `affectedPaymentIds`, and optional `resolvedAt`.
- Define `IdempotencyKey` with `key`, `scope`, request fingerprint, stored
  response, and `createdAt` plus a TTL index. Define `ComplianceScreening` with
  normalized `address`, `chain`, `provider`, `riskLevel`, `sanctioned`,
  `checkedAt`, protected `rawResponse`, provider/list version, and a short-lived
  cache TTL.
- Define `WalletAddress` with monotonic `derivationIndex`, `xpubId`, optional
  `assignedPaymentId`, and status limited to `available | assigned | retired`.
  Once assigned, its address, merchant, xpub, and derivation metadata are
  immutable and the address is never assigned to another payment.
- Store address/checksum-normalized lookup fields without exposing derivation
  metadata through merchant APIs.
- Add compound, unique, partial, and TTL indexes matching actual query paths,
  including unique event identity, unique event claim, derivation indexes,
  idempotency scope/key, `{ chain, token, status }` payment scans,
  `{ chain, contractAddress, blockNumber }` event scans, and appropriate TTLs
  only for provisional data whose deletion cannot damage financial/audit history.
- Define immutable raw event records and append-only audit access patterns.
  Reorged events are marked non-canonical and never deleted.
- Implement tamper-evident audit hash chaining or an equivalently documented
  append-only integrity control.
- Add transaction helpers that refuse correctness-critical operation when the
  database does not support transactions.
- Define a migration/index deployment strategy with safe rollback and startup
  compatibility checks. Do not rely on production `autoIndex` behavior.
- Encode all monetary fields as validated positive/non-negative integer strings
  as appropriate and centralize safe `bigint` conversion.

Validation gate:

- Schema tests reject unknown fields, invalid amount formats, invalid states,
  and forbidden signing material.
- Schema contract tests assert every required field, enum, immutable property,
  reference, compound index, uniqueness constraint, and TTL listed above.
- Index tests prove duplicate event, event claim, address allocation, and
  idempotency writes fail atomically under concurrency.
- Audit entries cannot be updated or deleted through any application service.
- Transaction rollback tests leave no partial payment/address/audit state.

Suggested commit: `Enforce persistence and audit invariants`

## Phase 03: Authentication, merchant isolation, and wallet onboarding

Branch: `phase/03-merchant-security`

Deliverables:

- Implement admin-approved merchant registration, email-verification hooks,
  approval status, suspension, and audited lifecycle changes.
- Generate high-entropy merchant API keys, return them once, store a salted
  password-grade hash plus prefix, and support scoped rotation/revocation.
- Add merchant authentication and data-access repositories that require
  `merchantId` for Payment, WalletAddress, wallet config, and webhook queries.
- Return `404`, not `403`, for cross-tenant payment identifiers and prevent
  timing/error details from confirming another tenant's record.
- Implement merchant webhook configuration and per-chain/token xpub
  registration with strict public-key/network validation.
- Detect and reject private keys, extended private keys, mnemonic-like input,
  seed phrases, and signing material before logging or persistence.
- Require step-up reauthentication for wallet material changes, audit the
  before/after metadata safely, and snapshot existing payment destinations so
  changes apply only to future payments.
- Implement admin JWT access/refresh flow, role checks, refresh rotation,
  revocation, brute-force protection, and separate admin rate limits.

Validation gate:

- Horizontal and vertical authorization tests cover every merchant/admin
  route, including guessed IDs and suspended/revoked credentials.
- Logs and errors contain no raw API keys, JWTs, xpub-sensitive metadata,
  private-key-like input, or cross-tenant data.
- Concurrent credential rotation and wallet updates cannot create an
  unauthorized or retroactive destination change.

Suggested commit: `Secure merchant identity and wallet onboarding`

## Phase 04: Admin chain and token registry

Branch: `phase/04-chain-token-registry`

Deliverables:

- Implement audited admin create/update/activation/soft-disable endpoints for
  Chain and Token. Do not expose merchant mutation or delete endpoints.
- Require two independently configured RPC provider URLs per chain, reject
  client-controlled outbound endpoints, and protect stored provider secrets.
- Require `Chain` records to contain `chainId`, display name, native-currency
  metadata, at least two independently operated RPC providers,
  `requiredConfirmations`, and `enabled`. Require `Token` records to contain
  chain reference, symbol, contract address, decimals, base-unit `minAmount`,
  base-unit `maxAmount`, token-behavior verification policy, and `enabled`.
- Create chains/tokens disabled. Activation is a separate audited action.
- Verify ERC-20 address, `symbol()`, `decimals()`, and `totalSupply()` through
  live viem calls; block decimal mismatch and duplicate/typo-squat contracts.
- Treat legitimate non-standard responses as manual-review cases without
  silently enabling the token.
- Prevent disabling while non-terminal payments exist unless an explicit,
  strongly confirmed and audited force operation records the consequences.
- Ensure live registry refresh stops new payment creation and new deposit
  watching promptly while already matched/confirming payments continue to
  terminal resolution.
- Snapshot chain confirmation requirements and token policy onto new payments.

Validation gate:

- Activation fails closed on provider disagreement, unreachable providers,
  wrong chain ID, contract mismatch, decimal mismatch, and duplicate contract.
- Tenant and role tests prove only admins can mutate registry data.
- Disable/force-disable concurrency tests cannot orphan open payments without
  the explicit audited override.

Suggested commit: `Add verified chain and token administration`

## Phase 05: Address allocation and merchant payment API

Branch: `phase/05-payment-intents`

Deliverables:

- Derive one unique receiving address per payment from a merchant-owned xpub
  using a monotonic index allocated atomically. Never derive, request, or refer
  to a private derivation path.
- Create payment, address assignment, idempotency record, destination screening
  request/result, and audit entry in a MongoDB transaction.
- Implement `POST /api/v1/payments` with merchant-derived ownership, strict
  input schemas, positive base-unit integer amounts, token min/max bounds, and
  server-clamped expiry limits.
- Honor merchant-scoped `Idempotency-Key`; replay identical requests from the
  stored response and reject key reuse with a different request fingerprint.
- Persist a new `Payment` with explicit `status: pending`, immutable
  `walletAddressId`, amount, token/chain identity, expiry, required
  confirmations, and applicable policy. The canonical recipient address lives
  on the immutable assigned `WalletAddress`; API/idempotency projections may
  snapshot the rendered address but must not create a mutable second authority.
- Generate a standards-compliant EIP-681 URI including chain, token contract,
  recipient, and exact integer amount.
- Implement tenant-scoped `GET /api/v1/payments/:paymentId`, capped
  confirmations, a `confirmed` boolean, safe partial/overpayment fields, and a
  lazy expired representation without exposing internals or provider details.
- Define address lifecycle behavior. Assigned addresses are never reassigned in
  a way that could cause a late transfer to credit another payment.

Validation gate:

- Unit/property tests cover zero, negative, signs, whitespace, leading zeros,
  decimal strings, exponent notation, token boundaries, and maximum integers.
- Concurrent creation tests prove derivation indexes and recipient addresses
  are unique and idempotent retries create exactly one payment.
- Tenant isolation and response contract tests prove internal wallet, database,
  derivation, and RPC details never leave the API.
- Address-pool exhaustion fails closed and alerts without issuing a duplicate.

Suggested commit: `Implement isolated payment intent creation`

## Phase 06: Chain adapter, durable watcher, and event ingestion

Branch: `phase/06-event-ingestion`

Deliverables:

- Define the exact chain-neutral `ChainAdapter` contract from `prompt.md`:
  `chainId`, `init()`, `getCurrentBlock()`, `getConfirmations(txHash)`,
  `isCanonical(txHash, expectedBlockNumber)`, `watchDeposits(callback)`, and
  `stop()`. Implement a factory keyed by `Chain.id`, with EVM-specific behavior
  isolated in the viem adapter and no EVM-only assumption in shared interfaces.
- Implement independent-provider health, chain-ID verification, automatic
  failover, bounded timeouts, disagreement handling, and failover metrics.
- Poll canonical logs and catch up from a persisted per-chain cursor after
  restart. Advance the cursor only after all events/block metadata in the batch
  are durably recorded.
- Refresh the enabled token/address registry without restart and verify every
  log's chain, configured token contract, transfer topic, and recipient.
- At watcher startup and every live registry refresh, call the enabled token
  contract's live `decimals()` through independent providers and compare it to
  stored configuration. On mismatch, disagreement, missing metadata, or an
  unverifiable response, stop watching/processing that token, fail closed,
  report degraded readiness, alert, and require admin review.
- Implement the private-network internal ingestion endpoint with mTLS/VPC
  deployment requirements plus versioned HMAC current/previous secrets.
- Sign and verify exact raw bytes over timestamp, nonce, and body using
  constant-time comparison; enforce skew limits and atomically consume nonces
  with TTL replay protection.
- Persist the verbatim raw payload before interpretation using one atomic
  insert/upsert with unique `eventId`, then enqueue a deterministic BullMQ job.
- Support standard tokens and explicit fee-on-transfer/rebasing verification
  policy through balance-delta checks for configured high-risk/high-value
  tokens. Keep future outbound safe-transfer behavior outside this service.

Validation gate:

- HMAC tests cover valid current/previous key, stale/future timestamp, duplicate
  nonce, tampered body, malformed headers, timing-safe comparison, and rotation.
- Fake-contract, disabled-token, wrong-chain, malformed-log, and unknown-token
  tests all persist the full potentially relevant raw event verbatim before
  judgment, reject it from payment processing, and retain it for replay/audit.
- Startup and refresh tests prove a live token-decimal mismatch or provider
  disagreement blocks watching and payment progression, degrades readiness,
  and alerts without corrupting amount comparisons.
- Watcher restart and provider outage tests prove no block range is skipped and
  cursor advancement never precedes durable writes.
- Duplicate ingestion and duplicate queue delivery produce one event record and
  one effective processing outcome.

Suggested commit: `Build durable verified event ingestion`

## Phase 07: Payment state machine, matching, and reorg recovery

Branch: `phase/07-payment-processing`

Deliverables:

- Implement the explicit guarded state machine for pending, matched,
  confirming, confirmed, expired, failed, plus a compliance hold representation
  that cannot emit a confirmation webhook.
- Enforce the exact transition table: `pending -> matched` only for an unexpired
  qualifying and unclaimed event; `matched -> confirming` on first block
  observation; `confirming -> confirming` only while confirmations remain below
  the snapshot; `confirming -> confirmed` only at/above the snapshot after a
  fresh canonicality and compliance check; `matched|confirming -> failed` only
  after a reorg removes the transaction and no replacement appears before the
  configured expiry grace; and `pending -> expired` only after expiry with no
  matching event. Every other transition is a rejected, auditable no-op.
- Match only configured chain, token contract/token identity, and unique
  recipient address. Amount alone is never a match key.
- Atomically claim an event for one payment forever. Use conditional writes,
  optimistic versions, transactions, deterministic queue jobs, and a
  payment-scoped distributed lock without treating the lock as the sole guard.
- Accumulate partial transfers without double-counting event IDs; record and
  expose underpayment, exact payment, amount received, and overpayment excess.
- Route late arrivals and expired partial payments to manual reconciliation
  under the fixed policy. Never silently ignore or auto-credit them.
- Move matched payments through confirmation tracking only when their
  transaction remains canonical. Cap external confirmation counts.
- Persist observed block hashes/parent hashes, detect fork points, mark orphaned
  events non-canonical, write ReorgRecord, replay replacement blocks, and safely
  resolve affected non-terminal payments.
- For a reorg deeper than configured finality, do not silently reverse or
  overwrite a terminal confirmed transition. Create an immutable finality
  incident, link affected confirmed payments/events, place automation on hold,
  page P1, expose the discrepancy in reconciliation, and require an authorized
  audited manual disposition.
- Emit append-only transition audit entries containing before/after, actor or
  process, event ID, transaction hash, and safe context.

Validation gate:

- Exhaustive table tests cover every legal and illegal transition and prove
  stale conditional writes are harmless no-ops.
- Exact, cumulative underpayment, overpayment, duplicate transfer, late arrival,
  wrong recipient, wrong token contract, and competing-worker tests pass.
- Multi-process chaos tests prove each transfer can satisfy at most one payment
  exactly once across retries, crashes, and lock expiry.
- Reorg simulation injects forks at multiple depths, preserves raw history,
  writes accurate ReorgRecord entries, correctly resolves non-terminal state,
  and never emits confirmation for a transaction that reorged before its
  threshold. A deeper-than-policy reorg preserves historical audit state,
  blocks automation, creates the incident/reconciliation records, and raises a
  P1 alert without silently rewriting terminal history.

Suggested commit: `Enforce exactly-once payment processing`

## Phase 08: Compliance screening and review controls

Branch: `phase/08-compliance-controls`

Deliverables:

- Define a pluggable `SanctionsScreeningProvider` with typed clear, flagged,
  blocked, unavailable, and indeterminate results.
- Implement at least one working, updateable OFAC-list-based fallback checker
  with provenance, freshness validation, deterministic address normalization,
  integrity verification, and a controlled list-update process.
- Screen the merchant destination at payment creation and the observed sender
  before confirmation. Record every request/result with provider, time, risk,
  list version, and appropriately protected raw response.
- Cache results only for a short configured TTL and schedule re-screening as
  lists change. Do not let stale cache or provider outage approve a payment.
- Hold blocked, unavailable, or ambiguous payments, prevent confirmation
  webhooks, and surface them to an admin manual-review queue.
- Add audited, role-restricted review decisions with explicit reason/evidence;
  do not present the software as legal certification.
- Create `COMPLIANCE.md` covering MSB/VASP uncertainty, sanctions, FATF Travel
  Rule, recordkeeping thresholds, hooks versus a compliance program, and the
  requirement for qualified jurisdiction-specific legal review.

Validation gate:

- Clear, sanctioned, unavailable, timeout, malformed-provider-response, stale
  list, and cache-expiry cases behave fail closed.
- No held payment can reach confirmed notification through any worker, admin,
  retry, or race path without an authorized audited resolution.
- Sensitive provider payloads and credentials are redacted from logs/errors.

Suggested commit: `Add fail-closed compliance screening`

## Phase 09: Webhooks, scheduled jobs, and reconciliation

Branch: `phase/09-operations-workflows`

Deliverables:

- Implement transactionally coordinated status outbox records so a committed
  transition cannot lose its webhook and a rollback cannot send one.
- Sign merchant webhooks over timestamp, nonce/delivery ID, and exact body with
  versioned per-merchant or platform secrets; document receiver idempotency on
  payment ID, status, and delivery/event ID.
- Deliver with BullMQ exponential backoff and jitter, bounded attempts, safe
  response capture, dead-letter queue, metrics, and audited admin replay.
- Enforce SSRF protections for webhook destinations: HTTPS policy, DNS/IP
  validation, blocked private/link-local/metadata ranges, redirect controls,
  rebinding defenses, timeouts, size limits, and operator policy.
- Add expiry sweep, confirmation/canonicality recheck, stuck-payment detection,
  screening recheck, registry refresh, and retention maintenance jobs with
  leader coordination and idempotent execution.
- Implement admin reconciliation for orphan events, late/partial/overpayments,
  stale matched/confirming payments, compliance holds, reorg effects, and
  webhook DLQ entries.
- Audit every admin view-changing action and reconciliation decision. AuditLog
  remains read-only through application APIs.

Validation gate:

- Crash tests at each transaction/outbox boundary prove no lost notification
  and no webhook for rolled-back or unconfirmed state.
- Retry, timeout, duplicate delivery, signature rotation, DLQ, and replay tests
  pass with at-least-once semantics.
- SSRF tests reject loopback, private networks, cloud metadata, malicious DNS,
  redirects, oversized responses, and non-HTTPS production destinations.
- Scheduler overlap and multi-replica tests produce one effective result.

Suggested commit: `Add reliable webhooks and reconciliation jobs`

## Phase 10: API hardening, observability, and readiness

Branch: `phase/10-security-observability`

Deliverables:

- Apply strict Zod validation with unknown-key rejection and explicit bounds to
  every route, header, query, and pagination input.
- Add helmet, explicit CORS allowlists, proxy/TLS deployment trust rules,
  request size/time limits, secure error handling, and endpoint-specific
  per-IP/per-key rate limits using a distributed store.
- Standardize error codes: `VALIDATION_ERROR`, `NOT_FOUND`, `INTERNAL_ERROR`,
  `CHAIN_ERROR`, `COMPLIANCE_HOLD`, `RATE_LIMITED`, and
  `IDEMPOTENCY_CONFLICT`, with no production stack/DB/RPC leakage.
- Add pino JSON request logging with `requestId`, `method`, `path`, `status`,
  `durationMs`, and applicable `paymentId`, `txHash`, `chain`, and `token`, plus
  centralized redaction of credentials, secrets, JWTs, signatures, and
  sensitive request bodies.
- Add Prometheus metrics for lifecycle totals and latency, expiry/failure/hold,
  RPC failover/outage, reorg depth, queue lag, stuck payments, and webhook
  outcomes.
- Add OpenTelemetry propagation across HTTP, queues, workers, DB, and RPC, and
  exception aggregation with secret-safe context.
- Implement `/health` as process liveness and `/ready` as bounded dependency
  readiness checking MongoDB, Redis/queues, and at least one healthy provider
  for each enabled chain without exposing provider identity. Readiness also
  fails/degrades when any enabled token's live decimals cannot be verified or
  disagree with stored configuration.
- Define alerts for all prompt-specified failure conditions and verify routing.

Validation gate:

- Fuzz/negative tests find no unvalidated route input or unsafe error response.
- Rate limits remain effective across replicas and distinguish public,
  merchant, admin, payment creation, and internal ingestion policies.
- Automated log scans show no seeded secrets or credential material.
- Readiness fails correctly for database, Redis, queue, and per-chain provider
  failures; liveness does not restart healthy processes for dependency outages.

Suggested commit: `Harden APIs and operational visibility`

## Phase 11: Deployment, documentation, and incident readiness

Branch: `phase/11-deployment-runbooks`

Deliverables:

- Build minimal non-root, reproducible container images for API, watcher,
  processor, and scheduler with graceful termination and resource guidance.
- Provide environment manifests/templates that keep services independently
  scalable and restrict internal ingestion by network policy and mTLS/VPC.
- Document secrets-manager integration, current/previous secret rotation,
  admin JWT rotation, API key rotation, webhook key rotation, and least
  privilege. Development variables remain examples only.
- Expand `.env.example` with at least two RPC URLs per configured chain, MongoDB
  replica-set URI/options, Redis connection string, production secrets-manager
  reference, sanctions-screening provider/API key settings, admin JWT current
  and previous/rotation metadata, internal HMAC current/previous secrets,
  webhook signing secret/version, log level, CORS origins, expiry/grace bounds,
  rate limits, and per-chain confirmation overrides. Values must be inert
  examples and contain no credential that works.
- Create `SECURITY.md` with the exact secret inventory, trust boundaries,
  custody statement, stored/not-stored key material, threat model, incident
  reporting, TLS requirements, and future HSM/MPC boundary for refunds/sweeps.
- Complete README architecture, setup, replica-set requirement, process
  operation, API usage, webhook verification/idempotency, testing commands,
  limitations, and v1 exclusions.
- Add runbooks for RPC outage/failover, deep reorg, stuck backlog, compliance
  hold review, secret rotation, webhook DLQ, address allocation exhaustion,
  data restoration, suspected tenant leak, and suspected double-credit.
- Document MongoDB encrypted backup/restore, Redis durability expectations,
  audit retention, recovery ownership, and explicit RPO/RTO targets.
- Copy the Known Pitfalls Checklist from `prompt.md` verbatim into
  `docs/PRE_LAUNCH_CHECKLIST.md` and make it a release gate.

Validation gate:

- Deploy all four process types in a production-like environment and exercise
  rolling restart, autoscaling overlap, network interruption, and recovery.
- Restore a backup into an isolated environment and prove documented RPO/RTO
  measurements rather than assuming them.
- Perform runbook tabletop exercises and correct every missing decision,
  unsafe command, unclear escalation, or unavailable signal.
- Documentation commands work from a clean checkout.

Suggested commit: `Document secure deployment and recovery`

## Phase 12: Full-system verification and release hardening

Branch: `phase/12-release-verification`

Deliverables:

- Complete unit coverage for state transitions, integer amount boundaries,
  idempotency, HMAC, tenant scoping, registry validation, compliance, and
  webhook signatures.
- Run integration tests against a local EVM chain and a documented testnet such
  as Sepolia with standard ERC-20, no-bool-return, fee-on-transfer, and other
  explicitly supported token behavior.
- Run deterministic reorg simulations, multi-worker concurrency/chaos tests,
  watcher kill/restart catch-up tests, provider disagreement/failover tests,
  Redis/Mongo disruption tests, and outbox delivery recovery tests.
- Load test sustained creation, event backlog processing, polling, webhook
  retry storms, address allocation exhaustion, and reconciliation queries.
- Perform SAST, dependency/license review, secret scanning, container scanning,
  API security testing, authorization/IDOR testing, SSRF testing, and an
  independent threat-model review. Resolve all critical/high findings and
  explicitly disposition lower findings.
- Reconcile database records against a known on-chain test ledger and prove no
  missed event, duplicate claim, incorrect amount, or unjustified transition.
- Complete the pre-launch checklist, compliance/legal handoff, operational
  ownership, alert paging test, rollback rehearsal, and release sign-off.

Validation gate:

- Every automated suite is repeatable and green from a clean environment.
- Concurrency and chaos runs demonstrate zero double-crediting and zero skipped
  block ranges under the documented fault model.
- Load objectives and service-level indicators are documented and met without
  weakening correctness, screening, confirmation, or audit controls.
- There are no unresolved critical/high security findings, missing required
  deliverables, skipped applicable tests, or unowned P1 alerts. A test marked
  not applicable has reviewer-approved evidence that the behavior is absent.
- Real-funds production use remains blocked until qualified legal/compliance
  review and operator release approval are recorded.

Suggested commit: `Complete production release verification`

## 4. Cross-phase regression rules

Starting with Phase 02, every phase must retain and expand these suites:

- Money invariants: integer-only storage/math and complete delta accounting.
- Exactly-once invariants: one event, at most one payment, one effective state
  transition, regardless of retry count or worker count.
- Durability invariants: raw event first, cursor last, no skipped block ranges.
- Finality invariants: confirmation depth plus canonicality plus compliance
  clearance precede confirmed status and confirmed webhook.
- Tenant invariants: every merchant-owned query is scoped in the repository;
  guessed foreign IDs reveal nothing.
- Custody invariants: no input, model, log, API, queue, or configuration path
  accepts private signing material.
- Audit invariants: transitions and sensitive config/admin actions are
  append-only, attributable, replayable, and retained through reorgs.
- Failure invariants: ambiguity and unavailable critical dependencies hold or
  stop processing rather than approving money-equivalent state.

## 5. Requirements traceability

Every row below is mandatory. The owning phase must retain automated test output
where feasible and documentation, review, or exercise evidence where automation
is not sufficient. Phase 12 verifies that every row has current evidence.

| ID | Prompt source | Owning phases | Required verification/evidence |
| --- | --- | --- | --- |
| `SPEC-00` | References to the original brief | Resolved by ADR 0001; verified in 12 | Retain the accepted owner decision that `prompt.md` supersedes prior or unavailable briefs; verify no later source was silently treated as authoritative. |
| `REQ-00` | Section 0 operating principles | All | Raw-event-first durability, replayable judgments, exactly-once event claims, confirmation/canonicality before irreversible action, server-owned truth, and fail-closed dependency/ambiguity tests remain green. |
| `REQ-01` | Section 1 business, custody, tenants, regulation | 01, 03, 08, 11, 12 | Non-custodial architecture has no signing-material path; tenant isolation/IDOR tests pass; README exclusions and `COMPLIANCE.md` contain the required non-legal-advice and qualified-review language. |
| `REQ-02` | Section 2 technology stack | 01, 02, 06, 10 | Strict TypeScript/Express, Mongoose replica-set transactions, viem/native `bigint`, BullMQ/Redis coordination, validated secret sources, pino/Prometheus/OpenTelemetry/error aggregation are built and exercised. |
| `REQ-03A` | Section 3.0 merchant onboarding | 03, 05 | Admin approval, verification hooks, one-time API key with salted hash/prefix, xpub-only wallet registration, private-material rejection, step-up wallet rotation, immutable existing destinations, and data-layer tenant scoping have security tests. |
| `REQ-03B` | Section 3.1 payment creation | 05 | Authenticated merchant ownership, exact positive integer amount and token bounds, unique xpub-derived address, clamped expiry, explicit pending status, confirmation snapshot, idempotency, destination screening, and EIP-681 output have boundary/concurrency tests. |
| `REQ-03C` | Section 3.2 payment status | 05, 07 | Foreign IDs return indistinguishable 404; lazy expiry works; confirmations equal `min(actual, required)` with boolean confirmation; partial/excess is safe; derivation, wallet, DB, and RPC internals never appear. |
| `REQ-03D` | Section 3.3 internal ingestion | 06 | Private network/mTLS deployment plus HMAC timestamp/nonce/raw-body validation, atomic nonce replay defense, atomic unique event insert, unconditional verbatim raw-event persistence before judgment, enabled-registry checks, and exact contract checks pass adversarial tests. |
| `REQ-03E` | Section 3.4 state machine and matching | 07 | Every legal/illegal guard is table-tested; match uses recipient/chain/token contract; under/over/late policies reconcile all value; event claim is globally unique; every transition has before/after and event/transaction audit data. |
| `REQ-03F` | Section 3.5 admin reconciliation | 03, 09, 10 | Admin short-lived JWT/refresh/RBAC, tighter limits, actor audit, and reconciliation views expose orphan, stale, compliance, late, partial, excess, reorg, and DLQ discrepancies. |
| `REQ-03G` | Section 3.6 chain/token registry | 04, 06 | Exact chain/token fields, disabled-by-default two-step activation, independent RPC/live ERC-20 verification, soft-disable/open-payment guard, snapshot semantics, refresh behavior, and before/after admin audit pass tests. |
| `REQ-04` | Section 4 data model | 02, 12 | Schema contract tests assert every prompt field, enum, reference, immutable property, strict unknown-field rejection, unique/compound/partial index, and safe TTL; financial/audit history cannot expire. |
| `REQ-05` | Section 5 chain adapter | 04, 06, 07, 12 | Exact adapter methods/factory, independent provider failover/alerts, durable catch-up cursor, block-parent reorg detection/replay, startup/live decimal checks, configured-token-only watching, and supported unusual-token balance behavior pass integration/chaos tests. |
| `REQ-06` | Section 6 idempotency/concurrency | 02, 05, 06, 07, 09, 12 | Replica-set enforcement, versioned conditional writes, deterministic queue jobs, distributed locks plus DB invariants, scoped request idempotency, and concurrent/crash tests demonstrate zero double-credit. |
| `REQ-07` | Section 7 address/key management | 03, 05, 06, 11 | Secret inventory proves no receiving private key/seed/mnemonic custody; only xpub derivation exists; current/previous HMAC rotation works; future signing/sweeps/refunds are documented as a separate HSM/MPC custodial component. |
| `REQ-08` | Section 8 background jobs | 09 | Idempotent multi-replica expiry, confirmation/canonicality recheck, stuck alerting, screening recheck, and registry/retention scheduling pass overlap/restart tests. |
| `REQ-09` | Section 9 security | 03, 06, 09, 10, 11, 12 | TLS infrastructure, strict bounded Zod inputs, replay resistance, distributed rate limits, RBAC/network controls, secret redaction/manager sourcing, CORS allowlist, helmet, exact lockfile/audit, SSRF controls, and safe errors pass security testing. |
| `REQ-10` | Section 10 compliance | 05, 08, 09, 12 | Working versioned screening provider checks destination and sender, logs each result, caches briefly, rechecks, blocks on unavailable/ambiguous/blocked, prevents confirmation/webhook, supports audited review, and carries no legal-certification claim. |
| `REQ-11` | Section 11 observability/audit | 02, 07, 09, 10 | Exact request fields/redaction, lifecycle and latency/failover/reorg/webhook metrics, all specified alerts including deep-reorg P1, and append-only/tamper-evident audit controls have automated or exercised evidence. |
| `REQ-12` | Section 12 extensibility | 04, 06 | Factory resolves by chain record, shared adapter contract remains non-EVM-specific, EVM deviations stay thin, and live token registry changes require no restart. |
| `REQ-13` | Section 13 API additions | 09, 10 | Liveness/readiness semantics, finality-safe HMAC webhooks with jitter/backoff/DLQ/replay and receiver idempotency contract, and every required error code/no-stack response pass contract tests. |
| `REQ-14` | Section 14 testing | Every phase; 12 final | Unit, testnet integration with standard/non-standard token, reorg harness, multi-worker chaos, watcher restart, and sustained load/address exhaustion tests are documented, repeatable, and green. |
| `REQ-15` | Section 15 deployment/operations | 01, 11, 12 | Independently scalable API/watcher/processor/scheduler, complete inert `.env.example`, required runbooks, and tested MongoDB backup/restore with stated measured RPO/RTO are present. |
| `REQ-16` | Section 16 known pitfalls | All; 11 copy; 12 release | Checklist is copied verbatim to `docs/PRE_LAUNCH_CHECKLIST.md`; every item maps to a test/review artifact and is signed off before release. |
| `REQ-17` | Section 17 deliverables and priority | 01, 08, 11, 12 | Architecture/folder/source/environment/README deliverables plus `SECURITY.md`, `COMPLIANCE.md`, runbooks, and checklist exist; release review confirms correctness/security/compliance priority over optimization. |

## 6. Definition of production-ready

The system is not production-ready until Phase 12 is merged and all prior
phase evidence remains valid. In addition to green automation, release requires
an independent security review, jurisdiction-specific legal/compliance review,
verified backups and restore, operational ownership, tested alerts/runbooks,
and an explicit decision by accountable human operators to enable real funds.
