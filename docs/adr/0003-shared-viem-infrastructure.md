# ADR 0003: Shared viem RPC and Contract Verification Infrastructure

- Status: Accepted
- Date: 2026-08-13
- Decision owner: Repository owner
- Relates to: `REQ-03G`, `REQ-05`, `REQ-12`

## Context

Phase 04 must verify chain identity and ERC-20 contracts through live RPC calls
before Phase 06 builds the continuous chain-watching adapter. Implementing a
temporary registry-only client and a separate watcher client would duplicate
provider failover, timeout, normalization, error classification, and contract
verification rules at a security-sensitive boundary.

## Decision

Phase 04 introduces a shared, low-level viem infrastructure layer for:

- Strict operator-configured provider construction and chain-ID verification.
- Independent-provider selection, bounded timeouts, health/failure
  classification, disagreement detection, and fail-closed results.
- Normalized EVM addresses and deterministic ERC-20 read operations for
  `symbol()`, `decimals()`, and `totalSupply()`.
- Typed results that distinguish valid, non-standard/manual-review,
  unavailable, disagreeing, and invalid contracts without guessing.
- Metrics and safe error context that never exposes provider credentials.

Phase 06 composes that infrastructure into the EVM implementation of the exact
chain-neutral `ChainAdapter` contract. It adds continuous polling, durable
cursor catch-up, deposit watching, canonicality, block-parent tracking,
failover alerts, and lifecycle management. It does not create a second viem
client stack with different validation or provider behavior.

Domain/application services depend on repository-defined interfaces rather
than viem types. Native `bigint` is used for chain arithmetic, while persistent
and API monetary values remain canonical base-unit integer strings.

## Consequences

- Phase 04 owns the first production implementation of shared RPC and contract
  reads; Phase 06 extends rather than replaces it.
- Registry activation and watcher startup/live refresh use the same token
  normalization and decimal-verification behavior.
- The shared `ChainAdapter` interface remains free of EVM-specific concepts so
  future non-EVM implementations do not inherit viem or EVM assumptions.
- Phase 04 tests provider disagreement and contract validation; Phase 06 and
  Phase 12 reuse those tests and add failover, restart, catch-up, and reorg
  coverage.
