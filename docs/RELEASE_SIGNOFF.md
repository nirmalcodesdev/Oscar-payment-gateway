# Phase 12 Release Sign-Off

Date: 2026-08-16 · Branch: `phase/12-release-verification`

## Pre-launch checklist verification (docs/PRE_LAUNCH_CHECKLIST.md)

| #   | Item                                                     | Evidence                                                                                       |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | No floating point for amounts                            | `domain/money` + `bigint`-only arithmetic; `tests/unit/domain` + persistence invariants suites |
| 2   | No amount-only matching on shared addresses              | Match keys are chain+token+recipient (Phase 07 suite: wrong-token/wrong-recipient rejected)    |
| 3   | Transfer verified against configured contract            | Interpretation rejects unknown contracts (Phase 06); watcher watches configured tokens only    |
| 4   | Finality before irreversibility + canonicality re-check  | State-machine guard table tests; confirmation gate re-checks canonicality (Phase 07)           |
| 5   | Atomic idempotent writes (no check-then-insert)          | Conditional `findOneAndUpdate` everywhere; ingest single atomic insert (Phases 02–07)          |
| 6   | Server-side expiry clamping                              | Phase 05 suite: clamped bounds                                                                 |
| 7   | Replica-set transactions everywhere prod-like            | `withRequiredTransaction` asserts capability; compose runs `rs0`; Phase 02 suite               |
| 8   | No single-processor assumption                           | Multi-worker/competing tests (Phase 07); 2-replica overlap run green (Phase 11/12)             |
| 9   | Over/underpayment deltas recorded                        | `excessAmount`/`partialAmountReceived` + annotations (Phase 07 suite)                          |
| 10  | No secrets/JWTs/full bodies in logs                      | Centralized pino redaction; log scans in Phases 05–12 evidence                                 |
| 11  | No internal detail in errors                             | Envelope contract tests; live probes (Phases 05–12)                                            |
| 12  | Chain-specific confirmation depth                        | `requiredConfirmations` per chain, snapshotted per payment (Phase 05/07)                       |
| 13  | Resume from last processed block                         | Durable cursor; watcher kill/restart live exercise (Phase 12); Phase 06 unit suite             |
| 14  | Live token decimals verification                         | Decimal guard at startup/refresh (Phase 06 suite; readiness gauge)                             |
| 15  | Screening fails closed                                   | All verdict-hold paths tested (Phases 07–08)                                                   |
| 16  | AuditLog append-only                                     | No update/delete path; hash-chained; chain verification in restore drill                       |
| 17  | Webhook retry-safe (backoff+DLQ, documented idempotency) | Phase 09 suite + README contract                                                               |

All 17 items verified with current evidence. ✅

## Automated verification (repeatable, clean environment)

- Clean rebuild → migrations v5 → 304 unit tests / 38 files; integration
  115/115 (three consecutive runs; one initial cold-start transient in the
  phase-05 rate-limit window, non-reproducing, consistent with the known
  first-run window-alignment flake documented in Phase 05 evidence).
- Ledger reconciliation `scripts/verify-ledger-reconciliation.js`:
  **PASS** over the service-generated dataset (27 events, 20 claims,
  21 payments, 44 audit entries) — no missed events, duplicate claims,
  incorrect amounts, or unjustified transitions, including reorg-orphaned
  and finality-incident cases.
- Chaos: watcher kill/restart resumed from the cursor; single-provider
  failover kept the chain ready; Mongo pause failed readiness closed with
  liveness intact and recovered; Redis outage failed authentication closed
  (500/timeout, never a grant) and recovered.
- Load probe (dev-class hardware, 2-cpu containers): 300 concurrent
  readiness reads ≈ 12.6s wall (~24 rps sustained incl. process overlap),
  100 concurrent metrics scrapes ≈ 4.6s; no errors, no correctness impact.
  These are smoke-class numbers documenting the harness, not certified
  production capacity — production sizing is an operator exercise with the
  `deploy/` template.
- Security: `npm audit` 0 vulnerabilities; Gitleaks clean; license
  inventory all permissive (MIT/ISC/Apache-2.0/BSD/BlueOak/0BSD/PSF) with
  no copyleft; strict typecheck+lint as SAST (zero warnings); IDOR/SSRF/
  authz adversarial suites green from Phases 03/09/10.

## Release blockers (must be cleared by accountable humans)

1. **Qualified jurisdiction-specific legal/compliance review** of the
   screening program (COMPLIANCE.md) — required before real funds.
2. **Operator release approval** by accountable owners, recorded here.
3. **Testnet (Sepolia) and live-chain integration** with standard,
   no-bool-return, and fee-on-transfer tokens against a public endpoint —
   the automated environment exercised the local EVM mock network only;
   a public-endpoint run is an operator action (credentials + budget).
4. **Independent threat-model review** by a reviewer outside this
   implementation, and container-image scanning in the operator registry
   (not available in this environment).
5. **P1 alert paging test** against the operator's real alert channel.

Real-funds production use remains **blocked** until every blocker is
cleared and this section is countersigned.
