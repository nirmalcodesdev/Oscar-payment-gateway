# Runbook: Suspected double-credit (P1)

## Detection

- Merchant reports duplicate confirmation; reconciliation shows one event
  satisfying multiple payments; audit anomalies.

## Immediate actions

1. Freeze automated merchant notification for the affected payments if
   still in flight (compliance/automation hold is the audited path; never
   direct DB writes).
2. Identify the claimed events: `on_chain_events.matchedPaymentId` is
   unique per event — a single event satisfying two payments should be
   impossible; verify no two payment ids reference overlapping claim sets.
3. Pull the audit chain entries for every implicated transition and
   verify chain integrity.

## Investigation

1. Determine whether the duplicates are: (a) two distinct on-chain
   transfers correctly credited twice, (b) a genuine defect, or (c) a
   merchant-side integration bug (duplicate webhook handling — receivers
   must deduplicate on delivery id).
2. For (b): reproduce via the concurrency/chaos suites, fix under the
   emergency-correction discipline, and re-verify exactly-once.

## Remediation

- Incorrect credits are reconciled through the finance process with an
  audited annotation; never silently reverse terminal history.
- If webhook duplicates were the cause, confirm receiver idempotency
  documentation with the merchant.

## Escalation

P1: engineering lead + finance owner; counsel if merchant funds moved.
