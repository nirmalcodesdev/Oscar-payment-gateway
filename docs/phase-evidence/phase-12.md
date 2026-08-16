# Phase 12 Validation Evidence

- Branch: `phase/12-release-verification`
- Status: Complete (release gated on human blockers)
- Started: 2026-08-16
- Completed: 2026-08-16

## ADR review

Outcome: No new ADR required. This phase verifies existing decisions; the
release-gate dispositions (testnet execution, independent review, legal
handoff) are recorded as explicit blockers in `docs/RELEASE_SIGNOFF.md`
rather than weakening any requirement.

## Verification performed

- **Clean-environment repeatability**: full `docker compose down`/rebuild
  → migrations v5 → `npm run validate` (304 unit / 38 files, build,
  compose gates) → integration 115/115. Three consecutive full runs green;
  the single cold-start transient is the documented phase-05 rate-limit
  window-alignment flake (non-reproducing; evidence precedent Phase 05).
- **Ledger reconciliation**: `scripts/verify-ledger-reconciliation.js`
  (committed, repeatable) proves over a service-generated dataset: every
  accepted canonical event claimed-or-annotated, one event→one payment,
  `amountReceived` equals the recorded cumulative (with the precise
  reorg/replacement semantics), every non-pending transition audited or
  review-flagged, confirmed-only-clear-screening, holds only with recorded
  finality incidents, and no signing material in stored payloads. Result:
  PASS (27 events / 20 claims / 21 payments / 44 audit entries).
- **Chaos/disruption**: watcher kill/restart resumed from the durable
  cursor with the chain ready; single-provider outage kept the chain ready
  via failover; a Mongo pause drove readiness closed (request hung to the
  dependency timeout rather than falsely ready) with liveness intact and
  full recovery; a Redis outage made authentication fail closed (no
  grant) and recovered cleanly. Outbox delivery recovery, competing
  workers, and deterministic reorgs are covered by the standing suites
  (Phases 06/07/09) and re-ran green here.
- **Load probe**: 300 concurrent readiness reads ≈ 12.6s and 100
  concurrent metrics scrapes ≈ 4.6s on the dev-class Compose topology with
  zero errors; documented as a smoke-class harness result, with production
  sizing delegated to the operator via the `deploy/` template (objectives
  documented, not certified here).
- **Security**: `npm audit` clean; Gitleaks v8.28.0 clean (~3.1 MB);
  license inventory exclusively permissive (MIT×313, ISC×24,
  Apache-2.0×22, BSD×14, BlueOak×5, 0BSD, PSF) with no copyleft — no
  licensing conflict for proprietary deployment; strict typecheck + ESLint
  (zero warnings) serve as the SAST pass; authorization/IDOR/SSRF
  adversarial suites from Phases 03/09/10 re-ran green; container scanning
  and the independent threat-model review are recorded as release
  blockers (unavailable in this environment).
- **Testnet/live-chain**: local EVM mock network exercised end-to-end;
  Sepolia/no-bool-return/fee-on-transfer against public endpoints is an
  operator action requiring credentials and budget — recorded as a
  release blocker, not skipped silently.
- **Pre-launch checklist**: all 17 §16 items verified with mapped evidence
  in `docs/RELEASE_SIGNOFF.md`.
- **Rollback rehearsal / alert paging**: backup/restore with measured
  RPO/RTO was proven in Phase 11; P1 paging against the operator's real
  channel is a release blocker (no external channel in this environment).

## Completion decision

All automatable Phase 12 gates pass from a clean environment, and the
ledger-reconciliation proof holds over real service-generated data. The
release remains correctly **blocked** on the human/accountable items
(legal review, operator approval, testnet run, independent review,
paging test) recorded in `docs/RELEASE_SIGNOFF.md`. This merge completes
the twelve-phase implementation plan; it does not authorize real-funds
operation.
