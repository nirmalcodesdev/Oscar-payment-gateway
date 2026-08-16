# Runbook: Stuck payments / queue backlog

## Detection

- Alerts `OscarStuckPayments` (matched/confirming beyond threshold) and
  `OscarQueueLag` (waiting depth > 1000).

## Actions

1. Check `/ready` per-chain readiness — RPC outage is the most common
   cause (see rpc-outage-failover runbook).
2. Check processor health (`docker service ps` / replicas) and
   `oscar_queue_lag` by state: growing `waiting` with idle workers means
   workers are down; growing `failed` means jobs are erroring.
3. Inspect processor logs for repeated job failures; failures retry with
   backoff and dead-letter after max attempts.
4. For dead-lettered interpretation jobs: inspect the event in
   reconciliation; replay only after the root cause is fixed.
5. Scale processor replicas if CPU-bound; jobs are safe to run N-wide
   (deterministic ids + conditional writes).
6. After resolution, confirm stuck annotations clear via the
   reconciliation view and alerts resolve.

## Escalation

On-call → engineering lead if backlog persists > 30 minutes.
