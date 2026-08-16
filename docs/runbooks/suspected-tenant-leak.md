# Runbook: Suspected tenant isolation leak (P1)

## Detection

- Merchant reports seeing another tenant's data; anomalous cross-tenant
  access in audit logs; security report.

## Immediate actions (contain first)

1. Do NOT delete or modify anything — preserve evidence (audit chains are
   append-only by design).
2. Capture the report: request ids, timestamps, payment ids, screenshots.
3. Check API logs for the request ids: tenant scoping is enforced in
   repository queries; cross-tenant reads must be indistinguishable 404s.
4. If a live credential is implicated: revoke it (admin credential
   deactivate) to stop ongoing access.

## Investigation

1. Query audit logs for the affected entities and actors in the window.
2. Reproduce with test tenants via the merchant API; the integration
   suite's cross-tenant cases are the reference behavior.
3. Determine blast radius: which merchants, which records, how long.

## Remediation & disclosure

1. Fix the defect on a dedicated branch with full validation gates
   (emergency-correction path in phases.md).
2. Notify affected merchants per contractual/legal obligations (counsel
   guidance); regulators as required.
3. Post-incident review; add regression tests proving the boundary.

## Escalation

P1: security owner + engineering lead + counsel.
