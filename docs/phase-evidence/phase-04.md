# Phase 04 Validation Evidence

- Branch: `phase/04-chain-token-registry`
- Status: Complete
- Completed: 2026-08-15

## ADR review

Outcome: New ADR required and accepted before dependent implementation.

Reviewed sources:

- `prompt.md` chain/token administration, provider verification, non-standard
  ERC-20 handling, soft-disable, audit, fail-closed, and snapshot requirements.
- `phases.md` fixed architectural decisions and the Phase 04 deliverables and
  validation gate.
- ADRs 0001 through 0006.

Accepted for this phase:

- ADR 0007: operator-selected provider catalog, independent-provider checks,
  shared-block ERC-20 verification, manual-review boundaries, safe projections,
  separate lifecycle commands, force-disable confirmation, and allocation
  sequence concurrency boundaries.

## Delivered contracts

- Admin-only chain and token create, update, activation, and soft-disable
  routes reject merchant credentials, raw RPC URLs, `enabled` mutation, and
  registry delete attempts.
- Provider IDs resolve only to operator-configured URLs. URL credentials and
  endpoint values are absent from persistence, responses, audit projections,
  and structured logs.
- Chains and tokens are disabled on creation. Chain activation verifies all
  configured providers and their numeric network identity. Token activation
  verifies deployed bytecode, decimals, symbol, and total supply at a shared
  block through viem.
- Decimal mismatch, missing bytecode, provider disagreement, wrong chain,
  unavailable RPC, and unknown contract behavior fail closed. Consistent
  optional-method non-standard behavior enters manual review without enabling.
- Manual approval is restricted to `balance_delta_required`, requires an
  acknowledged bounded reason, and appends a dedicated audit event.
- Normal deactivation checks open payments inside a replica-set transaction.
  Force deactivation requires resource-bound literal confirmation and an
  audited reason. Allocation sequence reservation races safely with disable.
- The enabled-registry reader refreshes deterministically and returns only
  enabled verified/manual-review records under enabled chains.
- Migration 0002 adds strict validators and the unique EVM network identity
  index while preserving migration 0001 history.

## Validation results

### Static, unit, coverage, and build gates

- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with zero warnings.
- `npm.cmd run validate:compose`: passed.
- `npm.cmd run validate`: passed formatting, zero-warning lint, strict type
  checking, 103 unit tests across 21 files, production build, Compose
  structural validation, and sanitized fail-closed process entrypoint checks.
- `npm.cmd run test:coverage`: passed every 80% threshold with 86.39%
  statements, 83.74% branches, 84.74% functions, and 86.39% lines.
- The admin registry router is excluded only from in-process unit coverage
  because every route is exercised against the built Docker API by the live
  Phase 04 suite.
- `git diff --check`: passed.

### Live Docker and integration gates

- Rebuilt application and RPC mock images from the finalized source.
- Migration exited successfully with `databaseSchemaVersion: 2`.
- Applied migration 0001 retained checksum
  `e00591dfb40834a7080dddd79aceac13c2cb9657a0769b01effd0a358b3d4e80`;
  migration 0002 recorded checksum
  `d81e8bb46e66e8d9537ac5f12e2fefc0e362d1cc9dabb12ba6a7c256fb71614a`.
- MongoDB replica set, Redis, API, watcher, processor, scheduler, proxies, and
  all three RPC mocks reported healthy/running.
- `GET /health` returned `{"status":"ok"}` and `GET /ready` returned
  `{"status":"ready"}` through `127.0.0.1:3000`.
- Focused Phase 04 suite: 5 tests passed without skips.
- Full integration suite: 23 tests passed across 4 files without skips.

### Security and operational evidence

- The live suite proved admin-only mutation, tenant/role separation, strict
  request rejection, safe projections, provider failure classification,
  manual-review controls, duplicate identity rejection, and disable races.
- API logs were reviewed for provider URLs, credentials, JWTs, API keys, raw
  contract/RPC errors, and sensitive request bodies; none were exposed.
- `npm.cmd run verify:ci-negative-controls`: isolated type, test, and secret
  fixtures were all rejected.
- `npm.cmd audit --audit-level=high`: passed online with zero vulnerabilities.
- Pinned Gitleaks 8.28.0 scanned approximately 1.45 MB across the complete
  worktree and reported no leaks.
- No Phase 05 payment or address-allocation implementation is included.

## Defects found and corrected

- Corrected integration fixtures that reused unique EVM network, token symbol,
  and contract identities; the full suite now validates production uniqueness
  constraints without weakening them.
- Made the Phase 03 shared-chain fixture remove only the chain it created so
  serial integration files cannot contaminate the Phase 04 network identity.
- Corrected optional ERC-20 outcome comparison so mixed standard/non-standard
  provider responses are a hard provider disagreement. Added a regression test
  while preserving unanimous non-standard results as manual-review cases.

## Completion decision

Every Phase 04 deliverable and applicable validation gate has passed. The phase
branch is eligible for its completion commit and merge into `main`. This does
not declare the gateway production-ready; Phases 05 through 12 and the final
release gates remain mandatory.
