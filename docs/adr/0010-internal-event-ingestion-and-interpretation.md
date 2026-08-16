# ADR 0010: Internal Event Ingestion Contract and Interpretation State

- Status: Accepted
- Date: 2026-08-15
- Decision owner: Repository owner
- Relates to: `REQ-03G`, `REQ-05`, `REQ-06`, `REQ-12`, `REQ-14`

## Context

Phase 06 exposes `POST /api/v1/internal/on-chain-events`, the single persistence
boundary for raw on-chain events. `prompt.md` §3.3 requires the endpoint to be
internal-only (private network plus mTLS/VPC in production, never HMAC alone),
to verify versioned HMAC signatures over `timestamp + nonce + body` with replay
protection, to persist the full raw payload verbatim before any interpretation
through one atomic database operation with a unique `eventId`, and to reject
events for chains/tokens that are not enabled while retaining them for replay
and audit. The fixed architectural decisions require BullMQ with deterministic
job IDs, bounded retries, exponential backoff with jitter, and dead-letter
handling, with database uniqueness remaining the final correctness boundary.
Phase 07 consumes interpreted events for matching; it must never receive an
event whose judgment is implicit or recoverable only by re-deriving registry
state.

## Decision

### Endpoint ownership and network boundary

- The endpoint is mounted only in the `api` process under
  `/api/v1/internal/on-chain-events` (ADR 0004: the API owns HTTP handling).
- Production deployments must place the endpoint behind mTLS or a VPC boundary
  in addition to HMAC; this is documented as an infrastructure requirement in
  `docs/runbooks/` during Phase 11. The development Compose topology keeps the
  API on the internal-only backend network, and HMAC plus strict validation are
  the application-layer controls. HMAC alone is never treated as a sufficient
  production boundary.

### Versioned HMAC scheme

- Request headers: `x-oscar-event-key-id`, `x-oscar-event-timestamp` (unix
  seconds), `x-oscar-event-nonce` (16-255 characters of
  `[A-Za-z0-9._-]`), and `x-oscar-event-signature` (lowercase hex).
- The signature is HMAC-SHA256 over the exact raw request body bytes prefixed
  by `${timestamp}\n${nonce}\n`, computed with the secret bound to the supplied
  key id. The Express JSON parser captures the raw bytes through its `verify`
  hook so the signed payload is byte-identical to the received body.
- Keys are versioned: `INGESTION_HMAC_CURRENT_KEY_ID`/`_SECRET` are required;
  `INGESTION_HMAC_PREVIOUS_KEY_ID`/`_SECRET` are optional and accepted only
  while rotating. Unknown key ids, malformed headers, or signatures that fail
  constant-time comparison (`crypto.timingSafeEqual`) are rejected with `401`.
- Timestamp skew beyond `INGESTION_TIMESTAMP_SKEW_SEC` (default 300) in either
  direction is rejected. Nonces are consumed by one atomic insert into
  `consumed_hmac_nonces` scoped by key id; the unique `(keyId, nonce)` index
  makes replay rejection a database guarantee, and the TTL index expires nonce
  records after `INGESTION_NONCE_TTL_SEC` (default twice the skew window).
  Nonce consumption happens only after signature verification succeeds.

### Persist before judgment

- The body schema is strict (unknown fields rejected) and carries the verbatim
  provider log plus normalized fields: `chain`, `transactionHash`, `logIndex`,
  `blockNumber`, `blockHash`, `contractAddress`, `fromAddress`, `toAddress`,
  `amount` (base-unit integer string), and `rawEvent` (arbitrary JSON kept
  verbatim).
- `eventId` is derived server-side as
  `event_<sha256(chain|transactionHash|logIndex)>` so every producer and every
  retry collapses onto one identity; clients never choose event identity.
- Persistence is one atomic `insertOne` inside a duplicate-key catch (never
  check-then-insert). The first insert stores the complete raw payload
  immutably; a duplicate returns the original outcome idempotently. The unique
  `(chain, transactionHash, logIndex)` index is a second database-level guard.
- Registry judgment (enabled chain, enabled token contract, transfer shape,
  known recipient) happens after durable persistence, in the processor. Fake
  contract, disabled token, wrong chain, malformed log, and unknown token
  events therefore all exist verbatim in `on_chain_events` before any judgment
  and are retained for replay and audit; they are only excluded from payment
  processing through explicit interpretation state.

### Queue contract

- After durable persistence the API enqueues one BullMQ job on the
  `${QUEUE_PREFIX}:event-interpretation` queue with `jobId = eventId`, so
  duplicate persistence paths enqueue at most one effective job. The job payload
  carries only `eventId`; the processor re-reads the event and current registry
  state from MongoDB (database as source of truth).
- Jobs use bounded attempts (5) with exponential backoff and jitter. Exhausted
  jobs remain in BullMQ's failed set, which is the v1 dead-letter surface;
  operators monitor and replay from it. Redis loss pauses processing but can
  never duplicate financial effect because interpretation writes are
  conditional and event identity is unique.

### Interpretation state (migration 0003)

`OnChainEvent` gains explicit, mutable interpretation fields; raw capture fields
remain immutable:

- `interpretationStatus: "accepted" | "rejected" | "review"` (absent until
  interpreted).
  - `accepted`: enabled chain, enabled token contract match, valid transfer
    shape, known recipient, and the token's verification policy satisfied.
    Only accepted events are matchable by Phase 07.
  - `rejected`: fake/unknown contract, disabled or missing token, wrong chain,
    malformed log, or unknown recipient. Retained, never matchable.
  - `review`: potentially relevant but unverifiable (for example a
    balance-delta check that providers cannot corroborate). Held out of
    matching and surfaced for reconciliation.
- `interpretationReason`: bounded machine-readable code for non-accepted
  outcomes.
- `verifiedReceivedAmount`: base-unit string recorded for
  `balance_delta_required` tokens (the observed recipient balance delta).
- `interpretedAt` and `interpretationRevision` (registry revision used).

The fields are added to `onChainEventSchema` without new indexes, which keeps
migration 0001's index-derived manifest and checksum stable (ADR 0005
boundary). Migration 0003 extends the `on_chain_events` JSON Schema validator
through `collMod` with the new optional properties and enum, following the
Phase 04 migration pattern.

### Balance-delta verification

For tokens whose `verificationPolicy` is `balance_delta_required`, the
processor reads the recipient's ERC-20 balance at the block before the transfer
and at the transfer block through at least two independent providers. The
observed delta becomes `verifiedReceivedAmount`; the event is `accepted` only
when providers agree and a delta exists. Fee-on-transfer and rebasing behavior
is therefore measured, not assumed. Disagreement, unavailability, or an
inconsistent read yields `review` with the reason recorded. Standard tokens
(`event_only`) are accepted on the log amount without balance reads. Outbound
safe-transfer behavior remains out of scope for this service.

## Threat assumptions

- Anyone who can reach the endpoint is hostile until HMAC, replay, and schema
  checks pass; network position alone is never proof of authenticity.
- Captured valid requests will be replayed; producers will crash and resubmit;
  the queue will redeliver.
- Registry state can change between persistence and interpretation.

## Consequences

- Duplicate ingestion and duplicate queue delivery provably produce one event
  record and one effective interpretation because identity, persistence,
  enqueue, and interpretation are each guarded at the database layer.
- Every judgment is replayable: raw events are immutable, interpretation is
  re-derivable from registry state, and rejected/retained events remain
  available for audit and incident review.
- Phase 07 matching consumes only `accepted` events and can trust
  `verifiedReceivedAmount` for high-risk tokens without re-implementing
  verification.
- Key rotation is continuous: current and previous keys overlap without a
  rejection window, and nonce scopes per key id keep rotation replay-safe.

## Verification

- Unit tests cover the HMAC matrix: valid current/previous key, stale and
  future timestamps, duplicate nonce, tampered body, malformed headers,
  constant-time comparison, and rotation overlap.
- Unit tests cover deterministic `eventId` derivation, duplicate-insert
  idempotence, and interpretation judgment tables including balance-delta
  outcomes with fake providers.
- Integration tests prove persist-before-judgment for fake-contract,
  disabled-token, wrong-chain, malformed-log, and unknown-token events;
  duplicate ingestion and duplicate delivery collapse to one record and one
  outcome; and replayed signed requests are rejected.
