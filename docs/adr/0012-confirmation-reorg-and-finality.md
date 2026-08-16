# ADR 0012: Confirmation Progression, Reorg Resolution, and Finality Incidents

- Status: Accepted
- Date: 2026-08-16
- Decision owner: Repository owner
- Relates to: `REQ-03D`, `REQ-05`, `REQ-08`, `REQ-11`

## Context

Phase 06's watcher halts a chain on parent-hash discontinuity and leaves the
cursor before the break for Phase 07 resolution. Phase 07 must move matched
payments through confirmation only while their transactions remain canonical,
resolve forks without losing or double-counting money, and honor the fixed
deep-reorg policy: a reorg deeper than a payment's snapshotted confirmation
requirement is a finality-assumption violation that preserves terminal
history, creates immutable incident records, blocks automation, and pages P1.
The processor owns payment state but holds no chain adapter today; the
watcher owns adapters and cursors but must not own payment transitions.

## Decision

### Confirmation progression

- When a payment becomes `matched`, the processor enqueues a deterministic
  BullMQ job `jobId = paymentId` on `${QUEUE_PREFIX}:payment-confirmation`
  (five attempts, jittered exponential backoff, failed set as the
  dead-letter record, mirroring ADR 0010). While below the snapshot the job
  completes and re-enqueues itself with the same deterministic id and a
  `CONFIRMATION_POLL_INTERVAL_MS` delay, so at most one active job per
  payment exists and duplicate enqueues collapse.
- Confirmation reads come from a corroborated reader in the processor built
  on the shared Phase 04/06 provider infrastructure (ADR 0003): confirmation
  depth is derived from corroborated block headers relative to the matching
  event's block, and canonicality means the event's block hash still matches
  the corroborated hash at that height plus the event remains
  `canonical: true`. Reader disagreement or unavailability fails closed: the
  payment stays unconfirmed and the attempt is retried.
- Phase 09's scheduled confirmation/canonicality recheck sweep remains the
  belt-and-braces driver for missed or delayed jobs; it does not replace
  this job path.

### Reorg resolution (watcher process)

- On `ChainDiscontinuityError` the watcher no longer halts indefinitely. It
  runs reorg resolution bounded by `REORG_MAX_SCAN_BLOCKS`:
  1. Walk observed blocks backward from the discontinuity comparing stored
     hashes against corroborated live headers to locate the fork point `F`.
  2. Mark every stored `ObservedBlock` above `F` that disagrees with the
     live chain `canonical: false` (records are never deleted).
  3. Mark `OnChainEvent`s in those blocks `canonical: false` (never deleted,
     never un-claimed).
  4. Write one `ReorgRecord` (`orphanedTxHashes` from orphaned events,
     `affectedPaymentIds` from their claims) and, for each affected payment,
     a reconciliation annotation (`reorg`).
  5. Transactionally rewind the chain cursor to `F` and resume the poll loop
     from there, so replacement blocks replay through the normal ingestion
     pipeline. Replacement events carry different event ids and flow
     through interpretation and matching like any new event.
- Unresolvable situations (no corroborated agreement on the live fork, scan
  bound exceeded) halt the chain exactly as Phase 06 did: cursor left before
  the break, readiness degraded, operator action required. Resolution never
  guesses.

### Payment resolution after a reorg (processor)

- `pending` payments with orphaned partial events keep their claims but have
  `partialAmountReceived` recomputed from canonical claimed events only.
- `matched | confirming` payments whose claimed events are orphaned stay in
  their state (no reverse transitions exist) and stop progressing: the
  confirmation job's canonicality check fails while events are
  non-canonical. A canonical replacement event for the same recipient
  re-links the payment (new claim, updated `matchedEventId`,
  `transactionHash`, recomputed `amountReceived`), and confirmation
  resumes. If no replacement appears before `expiresAt +
LATE_PAYMENT_GRACE_SEC`, the payment transitions to `failed` with audit
  and a `reorg` annotation.
- A completed match whose canonical claimed total falls below the expected
  amount after orphaning (an earlier partial disappeared) is never silently
  un-matched: the payment keeps its state, the shortfall is annotated
  (`reorg`, manual review) for an audited manual disposition.

### Deep-reorg finality incidents

- A reorg that orphans events claimed by a `confirmed` payment at a depth
  exceeding that payment's snapshotted `requiredConfirmations` is a
  finality-assumption violation. The system:
  - preserves the historical confirmed transition and the audit chain
    untouched (terminal history is never rewritten);
  - writes the `ReorgRecord` and links the affected confirmed payments and
    events;
  - sets `automationHold: true` (and records the incident `reorgId`) on the
    payment through migration 0004 — every downstream automated action,
    including Phase 09 webhook emission, must refuse to act for held
    payments;
  - writes an immutable annotation (`reorg`, manual review) and an audit
    entry;
  - emits an error-level `p1_finality_incident` log record. Paging
    integration lands with Phase 10 alerting; Phase 07 creates the immutable
    incident evidence and blocks automation.
- Recovery from an incident requires an authorized, audited manual
  disposition (Phase 08/09 review tooling); no automated path clears an
  automation hold.

## Consequences

- Reorgs preserve all raw history: observed blocks, events, claims, audits,
  and reorg records are append-only or flag-only.
- Cursor rewind plus normal replay means replacement blocks reuse the
  existing verified ingestion path instead of a special-case writer.
- The processor gains read-only chain access through the shared provider
  layer; it never writes chain state.
- `payments` gains `automationHold`/`automationHoldReorgId` and
  `on_chain_events` gains a `{chain, blockNumber}` serving index via
  forward-only migration 0004.
