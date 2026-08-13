# ADR 0001: Authoritative v1 Specification

- Status: Accepted
- Date: 2026-08-13
- Decision owner: Repository owner
- Resolves: `SPEC-00`

## Context

`prompt.md` is a hardened expansion that refers to an earlier "original brief"
for inherited API fields, data-model fields, structural deliverables, and other
details. That earlier brief is not available in this repository and cannot be
reliably reconstructed without introducing assumptions that were not approved
by the repository owner.

`phases.md` therefore established `SPEC-00` as a fail-closed prerequisite: the
original brief had to be added and traced, or the owner had to explicitly make
the current prompt the complete source of truth.

## Decision

The repository owner declares:

> The current `prompt.md` supersedes every prior or unavailable brief and is the
> complete authoritative specification for Oscar Payment Gateway v1.

References in `prompt.md` to "the original brief," "original fields," or
"original deliverables" do not create additional requirements outside the
repository. The requirements explicitly present in `prompt.md`, together with
the documented architectural choices that the prompt delegates to the
implementer, define v1.

`phases.md` is the implementation and verification plan derived from that
authoritative specification. It may add stricter production safeguards when
they do not contradict or weaken `prompt.md`.

## Consequences

- `SPEC-00` is resolved as of this ADR's acceptance date.
- Phase 01 may begin from the accepted plan without waiting for another brief.
- Schema and API contracts must implement every applicable field and behavior
  explicitly present in `prompt.md` and traced in `phases.md`.
- An earlier brief discovered later has no authority over v1 unless the owner
  accepts it through a new ADR and updates requirements traceability.
- Changes to v1 scope require an explicit specification change, traceability
  update, tests, review, and the repository's branch/commit/merge workflow.
- This decision resolves specification provenance only. It does not waive any
  implementation, security, compliance, testing, legal-review, or release gate.

## Verification

- `AGENTS.md` identifies `prompt.md` as the authoritative v1 specification and
  links to this ADR.
- `phases.md` marks `SPEC-00` resolved and retains the decision as a Phase 12
  release-verification artifact.
- Phase 12 verifies `REQ-00` through `REQ-17` against `prompt.md` and the
  accepted ADRs.
