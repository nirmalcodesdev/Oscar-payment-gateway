# Runbook: RPC provider outage / failover

## Detection

- Alert `OscarRpcProviderOutage` (oscar_chain_ready == 0 for an enabled chain).
- Watcher logs "All chain providers are unavailable"; readiness degrades.

## Impact

- No new blocks observed for the chain; payments stay matched/confirming
  (no confirmations advance). Nothing is lost: the durable cursor resumes
  from the last processed block on recovery.

## Actions

1. Identify the affected chain (alert label / readiness check name).
2. Check provider status pages; the catalog (env) holds operator identity.
3. If one provider of several is down: the adapter fails over
   automatically; confirm `oscar_chain_ready` stays 1. No action needed.
4. If all providers are down for a chain:
   - Do NOT disable the chain while payments are open unless funds safety
     requires it (disable blocks new payments; open ones still resolve).
   - Escalate to the provider; watch for recovery (readiness flips back).
5. On recovery: the watcher replays missed blocks from the cursor; verify
   `oscar_queue_lag` drains and stuck-payment annotations clear.

## Escalation

On-call engineer → infra owner → provider support. Record the incident and
outcome in the audit log via an admin annotation if any payment needed
manual attention.
