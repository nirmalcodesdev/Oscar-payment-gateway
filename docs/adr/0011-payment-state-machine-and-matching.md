# ADR 0011: Payment State Machine, Event Claiming, and Matching Policy

- Status: Accepted
- Date: 2026-08-16
- Decision owner: Repository owner
- Relates to: `REQ-03D`, `REQ-03E`, `REQ-04`, `REQ-06`, `REQ-10`

## Context

Phase 07 implements `prompt.md` §3.4: the guarded payment state machine
(`pending → matched → confirming → confirmed` with `expired`/`failed`
terminal off-ramps), matching of interpreted on-chain events to payments, and
exactly-once claiming of events. Phase 06 delivers interpreted events with an
`accepted | rejected | review` judgment and a unique partial index on
`OnChainEvent.matchedPaymentId` (`uq_event_payment_claim`). The fixed
architectural decisions resolve the underpayment (accumulate, never match
early), overpayment (permit within operator policy, expose excess), and
late-arrival (manual reconciliation during a configurable grace window,
never auto-credit, never discard) policies. Conditional writes, optimistic
versions, transactions, deterministic queue jobs, and a payment-scoped
distributed lock are all required, with database uniqueness as the final
correctness boundary.

## Decision

### State machine contract

- A pure domain function owns the transition table exactly as §3.4 defines
  it. It answers "is `from → to` legal under the guard" from immutable
  inputs; it performs no I/O and holds no state.
- Transitions are executed only through conditional
  `findOneAndUpdate({ paymentId, status: expectedFrom, version: expectedVersion }, ...)`
  writes inside the state-machine service. A `null` result means another
  worker moved the payment first: the attempt is a harmless no-op that is
  still recorded as a rejected transition audit entry (before/after, actor,
  eventId, txHash), never an error and never a retry-overwrite.
- Legal transitions:
  - `pending → matched` only for an unexpired, qualifying, unclaimed event
    set (cumulative canonical claimed amounts reach the expected amount).
  - `matched → confirming` on first block observation.
  - `confirming → confirming` only while observed confirmations remain below
    the snapshotted `requiredConfirmations`.
  - `confirming → confirmed` only at/above the snapshot after a fresh
    canonicality check and a fresh compliance check of the event sender.
  - `matched | confirming → failed` only when a reorg orphaned the matching
    events and no canonical replacement appeared before
    `expiresAt + LATE_PAYMENT_GRACE_SEC`.
  - `pending → expired` only after `expiresAt` with no qualifying event ever
    claimed.
- Stored confirmation counts are capped at the snapshot; external responses
  cap them the same way (Phase 05 contract).

### Compliance hold representation

- A hold is not a new state. `screeningStatus: flagged | blocked` on the
  `Payment` is the representation: the `confirming → confirmed` guard
  requires a fresh clear result for the event sender, so a held payment can
  never reach `confirmed` and can never emit a confirmation webhook
  (webhooks arrive in Phase 09 and must respect this).
- At the confirmation gate the sender address is screened through the
  pluggable provider (static list today; Phase 08 extends). `blocked`
  writes `screeningStatus: blocked`, an annotation (`compliance`), and an
  audit entry; the payment stays `confirming` under hold. Provider failure
  fails closed: no confirmation, annotation `compliance`, no crash.

### Event claiming

- "One event satisfies at most one payment, forever" is structural:
  `matchedPaymentId` is a single scalar on the event document, and claims are
  written only through conditional
  `findOneAndUpdate({ eventId, matchedPaymentId: { $exists: false } }, ...)`
  inside the same transaction that transitions or accumulates on the payment.
  A payment may claim many events (partial accumulation, excess top-ups,
  reorg replacement re-links), so the Phase 02 unique index on
  `matchedPaymentId` — which capped a payment at one event — is replaced by
  the non-unique serving index `ix_event_payment_claim` in migration 0004.
- Every claim transaction re-reads the payment inside the session; if the
  payment moved concurrently the whole claim aborts and rolls back, so no
  event is ever left claimed against an unadvanced payment. The loser
  records the rejected attempt as an auditable no-op.
- A Redis lock keyed `oscar:payment-lock:<paymentId>` (SET NX PX with a
  random token, released only by token-compare-and-delete) serializes
  match+transition per payment to reduce contention, but no code path
  treats lock ownership as proof of exclusivity. Lock expiry mid-work is
  safe because the conditional writes re-verify status and version.

### Matching rules

- Match keys are exactly `chain`, resolved token identity
  (`token`/contract), and the unique recipient wallet address. Amount is
  never a match key. Under Option A (ADR 0008) each `WalletAddress` is
  assigned to at most one payment, so multiple candidate payments are
  structurally impossible, not heuristically resolved.
- Matching runs in the processor after an event's interpretation returns
  `accepted` (including the `applied: false` duplicate-delivery path).
  `rejected` and `review` events never match; `review` events are retained
  for the reconciliation queue.
- Partial transfers: an accepted canonical event below the expected amount
  claims the payment, links via `matchedPaymentId`, and the payment stays
  `pending` with `partialAmountReceived` recomputed as the sum of canonical
  claimed event amounts (recomputed, never incremented, so orphaning stays
  correct). The completing event (cumulative ≥ expected) transitions
  `pending → matched`, sets `matchedEventId`, `transactionHash` (the
  completing event), and `amountReceived` (cumulative). All claimed events
  necessarily sit at or below the completing event's block, so confirming
  the completing event at the snapshotted depth implies every contributing
  event has at least that depth.
- Overpayment: permitted by default under `OVERPAYMENT_ALLOW` (default
  `true`); the excess (`amountReceived − amount`) is stored on
  `excessAmount`, flagged `overpaymentFlag`, audited, and annotated
  (`excess`) for reconciliation. When the operator disables tolerance, an
  over-amount event is annotated (`excess`) and left unclaimed for manual
  review; it is never silently absorbed or dropped.
- Late arrival: an accepted canonical event for a recipient whose payment is
  past `expiresAt` never auto-credits. If no event was ever claimed the
  service may apply the legal `pending → expired` transition; the event is
  annotated (`late`) for manual reconciliation during the configured grace
  window. Expired partial payments are annotated (`partial`) for manual
  refund/reconciliation review per the fixed policy.
- Every applied or rejected transition writes an append-only hash-chained
  audit entry with before/after status, actor (`system:processor`), the
  triggering `eventId` and `transactionHash`, and safe context.

## Consequences

- Matching, claiming, and transition decisions are replayable from the
  durable event history and audit chain.
- Stale workers can never double-credit: every state change re-verifies
  status, version, and claim ownership.
- The confirmation gate needs chain access in the processor; ADR 0012
  defines the corrobored confirmation reader that provides it.
- Phase 09 webhook emission must check `screeningStatus` and the Phase 07
  automation-hold flag before sending confirmation notifications.
