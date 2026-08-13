# Phase 01 Validation Evidence

- Branch: `phase/01-foundation`
- Status: Complete
- Started: 2026-08-13

## ADR review

Outcome: New ADR required and accepted before implementation.

Reviewed sources:

- `prompt.md` sections 0, 1, 2, 6, 7, 9, 14, 15, and 17.
- `phases.md` fixed decisions and Phase 01 deliverables/validation gate.
- ADR 0001: authoritative v1 specification.
- ADR 0002: merchant webhook egress boundary; no Phase 01 egress
  implementation is authorized.
- ADR 0003: shared viem infrastructure; Phase 01 must not introduce a competing
  RPC client.

Accepted for this phase:

- ADR 0004: service foundation, process boundaries, consistency boundaries,
  Option A direction, viem ownership, and threat assumptions.

## Environment observations

- Node.js `v24.14.0` is available.
- npm `11.9.0` is available through `npm.cmd`; PowerShell blocks `npm.ps1`.
- Docker Desktop `4.86.0` and Linux Engine `29.7.2` were installed and verified.
  Application files are under `D:\Docker\Docker`; WSL engine data is under
  `D:\Docker\wsl`, including `disk\docker_data.vhdx` and `main\ext4.vhdx`.
- The engine uses the `desktop-linux` context with WSL 2. The machine PATH
  contains `D:\Docker\Docker\resources\bin`.

## Validation results

### Passed locally

- `npm.cmd ci --ignore-scripts`: passed from `package-lock.json` after one
  transient Windows `EBUSY` retry; 376 packages reconstructed.
- `npm.cmd run format:check`: passed.
- `npm.cmd run lint`: passed with zero warnings permitted.
- `npm.cmd run typecheck`: passed with strict TypeScript settings.
- `npm.cmd run test`: 26 unit tests passed across 8 files.
- `npm.cmd run test:coverage`: passed the 80% thresholds with 97.68% statements,
  86.74% branches, 100% functions, and 97.68% lines for Phase 01 unit-owned
  modules. MongoDB, Redis, and process startup remain integration-owned.
- `npm.cmd run build`: passed and emitted all four process entry points.
- `npm.cmd run validate:compose`: parsed `compose.yaml` and verified required
  services, independent process commands, internal networking, replica-set
  configuration, health checks, loopback-only published ports, no-new-
  privileges, init handling, and non-root application execution.
- `npm.cmd run validate:entrypoints`: loaded every compiled entry point under
  Node.js and verified it exits nonzero with a sanitized error when required
  configuration is absent.
- `npm.cmd audit --audit-level=high`: passed online with zero vulnerabilities.
- Repository diff check: no whitespace errors.
- Focused secret/signing-material scan: no credential or private signing
  material detected; expected non-custodial documentation wording was the only
  private-key phrase match.

### Passed live container and integration gates

- `docker compose config --quiet`: passed canonical Compose validation.
- `docker compose up --build --wait --wait-timeout 300`: built every image and
  brought MongoDB, Redis, API, watcher, processor, scheduler, and both host
  proxies to their expected healthy/running state; replica-set initialization
  exited successfully with code 0.
- Live API checks returned `200 {"status":"ok"}` from `/health` and
  `200 {"status":"ready"}` from `/ready` through `127.0.0.1:3000`.
- MongoDB reported replica set `rs0`, state `PRIMARY`, at `mongodb:27017`.
- `npm.cmd run test:integration` ran with the documented loopback URI and passed
  the commit and forced-rollback assertions without skips.
- API, watcher, processor, and scheduler each received Docker's normal
  `SIGTERM`, logged process start plus shutdown start/completion, exited 0, and
  restarted successfully. Full Compose health passed afterward.
- Live topology inspection proved core API and MongoDB remain internal-only.
  Only non-root, read-only, capability-free fixed proxies own the loopback API
  and MongoDB bindings.

### Defects found and corrected by live validation

- MongoDB's implicit `/run/secrets` directory inherited file mode `0400`, so
  the runtime `mongodb` user could not traverse it after initialization. The
  image now creates the directory as `mongodb:mongodb` mode `0700` while the
  key remains mode `0400`; structural checks enforce both invariants.
- Docker suppresses host publishing for containers attached only to an
  internal network. Core services were kept internal-only and hardened
  fixed-destination host proxy services were added instead of moving the core
  services onto a routed bridge. ADR 0004 records this boundary.

### CI and security gates

- `npm.cmd run verify:ci-negative-controls`: an isolated temporary type error,
  failing test, and committed credential fixture were each rejected; the
  temporary repository was removed afterward. CI runs this proof.
- Pinned Gitleaks `8.28.0` scanned all three existing commits and separately
  scanned the full current worktree; both scans reported no leaks.
- Pinned Anchore Grype `0.100.0` scanned source and lockfile inputs and reported
  no fixable high-severity vulnerabilities.
- The final clean lockfile reconstruction installed 376 packages and the full
  validation, coverage, online audit, and whitespace chain passed.

## Completion decision

Every Phase 01 deliverable and required validation gate has passed. The phase
branch is eligible for its completion commit and merge into `main`.
