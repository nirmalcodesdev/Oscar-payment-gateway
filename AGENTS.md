# Repository Engineering Rules

These instructions apply to every contributor and every change in this
repository.

## Source of truth

- Read `prompt.md` completely before making architectural or implementation
  decisions.
- Treat `prompt.md` as the product, security, compliance, operations, and
  testing specification. Do not silently weaken or omit a requirement.
- `prompt.md` references an "original brief" that is not currently present.
  Do not claim specification completeness until that brief is added and traced,
  or the repository owner explicitly records that `prompt.md` supersedes it and
  is the complete source of truth.
- Use `phases.md` as the execution order and requirements traceability plan.
- When requirements conflict, prioritize money correctness and idempotency,
  then security and fail-closed behavior, compliance hooks, observability,
  maintainability, and finally optimization.

## Phase workflow

- Begin every implementation phase from an up-to-date `main` branch.
- Create a dedicated branch named `phase/NN-short-description` before changing
  implementation files for that phase. Do not implement phases directly on
  `main`.
- Keep the branch limited to the phase scope unless a prerequisite correction
  is necessary for safety or correctness. Document any scope change.
- Implement production-quality code, tests, security controls, documentation,
  migrations, and operational changes required by the phase.
- Run every test and validation gate listed for the phase. Required gates must
  not be skipped. A check may be marked not applicable only when the phase does
  not contain the behavior it tests and reviewer-approved evidence records why.
  A phase is not complete while any applicable check is failing, skipped, or
  dependent on an unverified assumption.
- Review the diff for secrets, tenant isolation, monetary precision,
  idempotency, concurrency, error handling, logging redaction, and fail-closed
  behavior before declaring the phase complete.
- Commit after the phase is successfully implemented and validated. Do not
  leave a completed phase uncommitted.
- Commit messages must be concise, imperative, and specific to the change.
  They must not mention AI tools or generation, and must not contain a person's
  name or an author attribution. Git's required author metadata is separate
  from the commit message and must remain truthful.
- Merge the phase branch into `main` only after implementation and all required
  tests succeed. Never merge a known-broken, partially implemented, or
  security-degraded phase.
- Record validation evidence in the phase commit, pull request, or repository
  documentation so the merge can be independently reviewed.

## Production safety

- Treat every defect as potentially capable of losing track of funds,
  double-crediting a merchant, leaking tenant data, or creating regulatory
  exposure.
- Preserve the non-custodial boundary. Never accept, store, transmit, log, or
  derive merchant private keys, seed phrases, mnemonics, or signing material.
- Store and calculate monetary values only as base-unit integer strings and
  native `bigint`. Never use floating point for money.
- Durably record relevant raw on-chain events before interpreting them. Make
  every decision replayable and auditable.
- Enforce idempotency and uniqueness at the database layer. Do not use
  check-then-write logic for correctness-critical operations.
- Require configured confirmation depth and canonicality before confirmation
  or outbound merchant notification.
- Enforce tenant scope in the data-access layer for every merchant-owned
  record. Cross-tenant record requests must not reveal record existence.
- Fail closed on ambiguity, RPC disagreement, unknown chain/token contracts,
  unavailable screening, missing token metadata, or unverifiable chain state.
- Never bypass a security control or required test to finish a phase faster.
- Never commit secrets, private `.env` files, credentials, tokens, raw JWTs,
  HMAC keys, private RPC credentials, or sensitive request bodies.
- Use atomic conditional state transitions, MongoDB transactions on a replica
  set, durable BullMQ jobs, and distributed coordination. Never rely on a
  single worker instance.
- Keep audit records append-only and preserve orphaned/reorged event history.

## Change discipline

- Prefer small, reviewable changes that follow existing architecture and
  conventions.
- Add or update tests for every behavior change and every fixed defect.
- Do not claim production readiness based only on unit tests. Complete the
  integration, concurrency, reorg, chaos, load, security, and operational
  gates defined in `phases.md`.
- If a requirement cannot be implemented or verified, stop the affected phase,
  document the blocker and risk, and do not merge it into `main`.
