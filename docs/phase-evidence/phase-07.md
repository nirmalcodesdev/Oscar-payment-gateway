# Phase 07 Validation Evidence

- Branch: `phase/07-payment-processing`
- Status: Complete
- Started: 2026-08-16
- Completed: 2026-08-16

## ADR review

Outcome: New ADRs required and accepted before dependent implementation.

Reviewed sources:

- `prompt.md` §3.4 payment confirmation state machine and matching rules,
  §3.5 reconciliation surfacing, §4 data model (Payment, OnChainEvent,
  ReorgRecord), §5 reorg detection, §6 idempotency/concurrency, §8 background
  jobs boundary with Phase 09, §10 compliance hold behavior, §11 audit and
  P1 alerting.
- `phases.md` fixed architectural decisions — late-payment, underpayment,
  overpayment, compliance, and deep-reorg policies — plus the Phase 07
  deliverables and validation gate, and the Phase 08/09 boundaries.
- ADRs 0001 through 0010, especially ADR 0005 migration boundaries, ADR 0008
  address allocation (unique address per payment), ADR 0009 watcher halting
  contract, and ADR 0010 interpreted-event handoff.

Accepted for this phase:

- ADR 0011: guarded state-machine contract with auditable no-op rejections,
  compliance hold representation, structural event claiming with
  session-scoped claim transactions, payment-scoped Redis lock as contention
  reduction only, matching keys (chain, token, recipient), cumulative
  partial accumulation recomputed from canonical claims, overpayment
  tolerance policy, and late-arrival manual reconciliation routing.
- ADR 0012: deterministic `paymentId`-keyed confirmation jobs that
  self-reschedule while waiting, corroborated confirmation/canonicality
  reads in the processor, bounded fork-point resolution with non-canonical
  history preservation and cursor rewind, replacement re-linking, and the
  deep-reorg finality incident (automation hold, immutable records, P1 log)
  that never rewrites terminal history.

## Delivered contracts

- `src/domain/payments/payment-state-machine.ts` implements the exact §3.4
  transition table as a pure function over immutable guard inputs; illegal
  attempts return structured rejection reasons for auditable no-ops.
- `PaymentMatchingService` executes claims and transitions inside one
  replica-set transaction that re-reads the payment in-session: a payment
  that moved concurrently aborts and rolls back the claim, so an event is
  never left claimed against an unadvanced payment. Partial transfers
  accumulate on `partialAmountReceived`; the completing event performs
  `pending → matched`; overpayment excess is stored, flagged, audited, and
  annotated; late arrivals route to manual reconciliation with the legal
  `pending → expired` transition; orphans and wrong-token deposits are
  annotated, never silently dropped.
- `PaymentConfirmationService` walks `matched → confirming → confirmed`
  with capped confirmation counts, a fresh corroborated canonicality check,
  and a fresh sender screening gate at the threshold: `blocked`/`flagged`
  hold the payment (annotation, screening record, no confirmation, no
  future webhook), provider failure fails closed, and a reorg that removes
  the matching transaction with no replacement before expiry plus grace
  applies the legal `matched|confirming → failed` off-ramp with audit and
  annotation.
- `EvmConfirmationReader` derives confirmations from the lowest corroborated
  provider tip and canonicality from per-provider header-hash agreement,
  returning `unavailable` on any disagreement so the caller fails closed.
- `PaymentConfirmationQueue`/`PaymentConfirmationWorkerResource` run the
  deterministic BullMQ job (`jobId = paymentId`) on
  `${QUEUE_PREFIX}:payment-confirmation`; waiting outcomes re-enqueue one
  delayed job; the interpretation worker invokes matching inline after an
  accepted outcome so collapsed duplicate deliveries cannot skip matching.
- `PaymentLock` provides token-checked Redis coordination
  (`SET NX PX`, compare-and-delete release); no code path treats it as the
  correctness boundary.
- `ReorgResolutionService` walks observed blocks backward against
  corroborated live headers (bounded by `REORG_MAX_SCAN_BLOCKS`), marks
  orphaned blocks and events non-canonically, writes the `ReorgRecord`
  linking orphaned transactions and affected payments, recomputes pending
  partial accumulations from surviving canonical claims, applies the
  deep-reorg automation hold (`automationHold`, `automationHoldReorgId`,
  `payment_finality_incident` audit, P1 `p1_finality_incident` error log,
  open reorg annotation) to confirmed payments without touching their
  terminal state, and rewinds the cursor conditionally so the watcher
  replays replacement blocks through the verified ingestion pipeline.
  Unresolvable situations (corroboration disagreement, scan bound exceeded,
  fork below anchored history) halt the chain exactly as Phase 06 did.
- Migration 0004 extends the `payments` validator with the automation-hold
  fields, replaces the Phase 02 unique claim index (which capped a payment
  at one claimed event and is structurally incompatible with cumulative
  partial accumulation) with the `ix_event_payment_claim` serving index,
  and adds `ix_event_chain_block` for reorg scans.
- Configuration adds `OVERPAYMENT_ALLOW`, `LATE_PAYMENT_GRACE_SEC`,
  `CONFIRMATION_POLL_INTERVAL_MS`, and `REORG_MAX_SCAN_BLOCKS`.

## Validation results

### Static, unit, coverage, and build gates

- `npm run typecheck`: passed.
- `npm run lint`: passed with zero warnings.
- `npm run validate`: passed formatting, zero-warning lint, strict type
  checking, 271 unit tests across 33 files, production build, Compose
  structural validation, and sanitized fail-closed entrypoint checks.
- `npm run test:coverage`: passed every 80% threshold with 90.61% statements,
  88.05% branches, 88.73% functions, and 90.61% lines; the new
  `src/domain/payments` module is at 100% on every dimension. The
  application processing/reorg services are exercised by the live
  integration suite against real MongoDB transactions, matching the
  established router-exclusion precedent.
- Phase 07 adds 15 exhaustive state-machine unit tests (every legal and
  illegal transition, every guard rejection path, terminal classification).
- `git diff --check`: passed.

### Live Docker and integration gates

- Rebuilt all application images from the finalized source; the stack
  starts healthy and the one-shot migration settles the database at
  `databaseSchemaVersion: 4` from a clean database.
- Focused Phase 07 suite: 20 tests passed without skips, covering exact
  matching with audit and confirmation enqueue, cumulative underpayment
  accumulation across three transfers, overpayment excess recording,
  tolerance-disabled routing, duplicate-delivery collapse, late-arrival
  expiry with manual reconciliation routing, expired-partial refund review,
  orphan and wrong-token deposits, competing-worker claims (8 concurrent
  matchers with independent locks settle exactly one `claimed_matched`
  with one audit entry and one claim), duplicate transfers racing to
  complete, confirmation progression with capped counts and terminal
  audit, self-loop auditing only on progress, blocked-sender compliance
  hold, fail-closed unavailable observations, reorg-grace failure, fork
  resolution with history preservation and cursor rewind, deep-reorg
  finality incident on a confirmed payment, replacement re-linking, and
  unresolvable-corroboration halting.
- Full integration suite: 89 tests passed across 7 files without skips
  (phases 02 through 07 plus transaction helpers).

### Security and operational evidence

- The claim, transition, confirmation, and reorg paths write only through
  conditional status/version-guarded updates inside replica-set
  transactions; the matching suite proves stale conditional writes are
  harmless auditable no-ops and that each transfer satisfies at most one
  payment exactly once under concurrency.
- Money arithmetic uses `bigint` and canonical base-unit strings only; no
  floating point appears in any processing path.
- Service logs were reviewed for HMAC/JWT/step-up secrets, database and
  migration credentials, API keys (logged as `[REDACTED]`), scrypt hashes,
  and xpub material; no secrets were exposed. Error-level entries during
  the suites correspond to intentionally exercised fail-closed paths
  (derivation exhaustion, full provider outage).
- `npm run verify:ci-negative-controls`: isolated type, test, and secret
  fixtures were all rejected.
- `npm audit --audit-level=high`: passed online with zero vulnerabilities.
- Pinned Gitleaks v8.28.0 scanned approximately 2.52 MB across the complete
  worktree and reported no leaks.

## Defects found and corrected

- Corrected the Phase 02 claim-index direction: the unique index on
  `matchedPaymentId` capped a payment at one claimed event forever, which
  cumulative partial transfers and reorg replacement re-links necessarily
  violate (surfaced as E11000 on the second claim). Migration 0004 now
  replaces it with a serving index; the one-event-one-payment guarantee is
  structural (single scalar claim written only conditionally). The Phase 02
  invariant test and model-index unit test were updated to the corrected
  contract.
- Corrected a claim-commit hazard found while designing the competing-worker
  test: the original transaction committed the event claim even when the
  payment's conditional transition lost a concurrent race, which could leave
  an event claimed against an unadvanced payment. All claim transactions now
  re-read the payment inside the session and abort (rolling back the claim)
  whenever routing changed; losers record auditable no-ops.
- Corrected migration 0004's replaced-index handling to tolerate
  `IndexNotFound` (code 27) so a partially applied attempt is re-runnable,
  after a database reset exposed that the original string-match on the error
  text never matched MongoDB's actual message.
- Corrected the nested-transaction hazard in reorg resolution (an audit
  append that opened its own transaction inside an open transaction) by
  using the in-transaction audit variant.
- Corrected integration fixtures: wallet derivation indices now vary per
  fixture (`uq_xpub_derivation_index`), transaction hashes are
  run-namespaced (`uq_chain_transaction_log`), reorg fixtures carry the
  simulated chain identity, expired-partial and reorg-grace scenarios seed
  their historical state directly because matching an already-expired
  payment correctly routes to late-arrival handling, and the scripted
  screening provider supplies the required provider/list versions.

## Completion decision

Every Phase 07 deliverable and applicable validation gate has passed. The
phase branch is eligible for its completion commit and merge into `main`.
This does not declare the gateway production-ready; Phases 08 through 12 and
the final release gates remain mandatory.
