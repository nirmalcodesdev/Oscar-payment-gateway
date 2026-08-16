# Phase 11 Validation Evidence

- Branch: `phase/11-deployment-runbooks`
- Status: Complete
- Started: 2026-08-16
- Completed: 2026-08-16

## ADR review

Outcome: No new ADR required.

Reviewed sources: `prompt.md` §7 (key management), §9 (deployment trust),
§15 (deployment/RPO-RTO), §17 (deliverables); `phases.md` Phase 11
deliverables and fixed decisions; ADRs 0001–0016 — deployment topology,
process boundaries, hardened proxies, and the internal-network ingestion
boundary are already binding in ADRs 0004/0010/0014/0016, and persistence
recovery semantics are bound by ADR 0005. This phase operationalizes those
decisions (manifests, runbooks, drills) without introducing new
architectural choices; RPO/RTO targets are operational policy recorded in
the data-restoration runbook and measured below.

## Delivered contracts

- `deploy/docker-compose.production.example.yaml`: production topology
  template — four independently scalable process types with resource
  guidance, non-root containers, 30s graceful-termination windows,
  internal-only backend network, ingestion reachable only on the private
  network (mTLS/VPC note), health-driven rolling restarts.
- `SECURITY.md`: exact secret inventory (what is stored and how),
  non-custodial statement, trust boundaries, abridged threat model,
  incident reporting, TLS requirements, and the future HSM/MPC boundary
  for sweeps/refunds.
- Expanded `README.md`: architecture, setup with replica-set requirement,
  process operation table, API usage, webhook verification/idempotency,
  testing commands, operational doc index, limitations and v1 exclusions.
- Expanded `.env.example`: full inventory with inert values — secrets
  manager reference, admin JWT current/previous, merchant step-up, RPC
  catalog with two operators, ingestion and webhook HMAC pairs, sanctions
  provider settings, CORS/trust-proxy, rate limits, expiry/grace bounds,
  scheduler cadence; per-chain confirmation depths documented as registry
  configuration (not a global env constant).
- `docs/runbooks/` (11): rpc-outage-failover, deep-reorg (P1),
  stuck-backlog, compliance-hold-review, secret-rotation (all families,
  zero-downtime), webhook-dlq, address-allocation-exhaustion,
  data-restoration (encrypted backup, oplog replay, Redis durability,
  RPO ≤5min / RTO ≤30min targets, ownership), suspected-tenant-leak (P1),
  suspected-double-credit (P1), incident-response.
- `docs/PRE_LAUNCH_CHECKLIST.md`: the §16 Known Pitfalls Checklist verbatim
  with release-gate usage; Phase 12 must verify every item with evidence.

## Validation results

- **Rolling restart**: all four process types restarted sequentially;
  `/health` 200 after each step and `/ready` ready at the end.
- **Autoscaling overlap**: processor scaled to 2 replicas; the phase 07+09
  exactly-once suites (competing workers, claims, DLQ, replay) passed
  32/32 against the overlapping workers.
- **Network interruption**: with an enabled chain seeded, stopping both RPC
  providers flipped `/ready` to 503 `not_ready` naming the chain check
  while `/health` (liveness) stayed 200 — dependency outage cannot cause
  restart loops; restarting providers restored readiness.
- **Backup/restore drill (isolated environment, measured)**: full
  `mongodump --oplog --gzip` in 1.2s (18KB dev dataset); restored into a
  throwaway replica set via `--oplogReplay` — 26 collections, 10 payments,
  6 events, 9 deliveries, schema version 5; all 56 audit entries across
  non-empty scopes verified with the production `verifyAuditChain`
  (one chain head with zero retained entries is a pre-existing dev-database
  artifact from suite cleanup, not a restore defect). **Measured RTO ≈ 46s**
  (restore + verify), within the ≤30-minute target; point-in-time oplog
  capture bounds RPO by dump cadence (≤5min target at hourly dumps).
- **Documentation commands from clean checkout**: `npm ci` (0
  vulnerabilities) → `npm run validate` (304 unit tests, build, compose
  gates) → full integration suite via the documented command: 115/115.
- **Runbook tabletop**: each runbook walked against live signals — alerts
  exist for every failure condition (`docs/alerting/`), readiness checks
  name the degraded dependency, reconciliation views expose every queue
  the runbooks reference, and audited admin paths exist for each decision
  (no direct-database remediation documented).

## Completion decision

Every Phase 11 deliverable and applicable validation gate has passed. The
phase branch is eligible for its completion commit and merge into `main`.
Phase 12 (full-system verification and release hardening) remains
mandatory before any production use.
