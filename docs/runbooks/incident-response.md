# Runbook: Incident response (security/funds severity)

## Severity

- P1: funds misattribution/double-credit, finality violation, tenant leak,
  secret exposure. Page immediately.
- P2: dependency outages with safe degradation (RPC, screening, Redis).

## Flow

1. **Contain**: revoke implicated credentials; hold affected payments via
   audited paths; isolate affected processes. Prefer availability-safe
   controls — the system fails closed by design.
2. **Preserve**: snapshot logs and the audit-chain state; no deletions.
3. **Communicate**: incident commander assigned; status channel; merchant
   and counsel notifications as required (tenant leak / double-credit
   runbooks).
4. **Resolve**: fix via the emergency-correction branch discipline with
   all validation gates; no shortcuts under pressure.
5. **Review**: blameless post-mortem with timeline from the audit chain;
   regression tests merged before closing.

## Contacts

Assign before launch: on-call engineer, infrastructure owner, security
owner, finance owner, counsel. Keep this table current in the deployment
manifest, not just here.
