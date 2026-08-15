# ADR 0007: Registry Verification and Disable Safety

- Status: Accepted
- Date: 2026-08-14
- Decision owner: Repository owner through the accepted Phase 04 plan
- Relates to: `REQ-00`, `REQ-03G`, `REQ-05`, `REQ-06`, `REQ-09`, `REQ-12`

## Context

Phase 04 introduces the platform chain and token registry. A bad registry write
can make a fake contract look payable, send a future payment to the wrong
network, expose an RPC credential, or stop observation of an open payment. The
specification requires admin-only mutation, two independent RPC providers,
live chain and ERC-20 verification, disabled-by-default records, soft-disable,
and an explicit override before open payments can be orphaned.

Several details require one durable interpretation. An administrator is still
a client of the HTTP API, so accepting a raw RPC URL in an admin request would
violate the operator-configured egress boundary. A platform chain identifier
such as `ethereum-sepolia` is not the numeric EVM chain ID returned by
`eth_chainId`. Provider independence cannot be inferred reliably from URL
syntax. Finally, token `symbol()` and `totalSupply()` failures may identify a
legitimate non-standard token, while a decimal mismatch can corrupt every
amount comparison and can never be overridden.

## Decision

### Operator-owned provider catalog

Raw RPC URLs are never accepted by an HTTP route. Operators configure a strict
runtime provider catalog outside the database. Each catalog entry contains a
non-secret `providerId`, an `operatorId` identifying the independently operated
provider, and the secret-bearing URL. Administrator requests select provider
IDs only. A chain must select at least two distinct provider IDs owned by at
least two distinct operator IDs.

New chain records persist only provider and operator IDs. RPC URLs remain in
the runtime secret boundary and never appear in API responses, audit entries,
MongoDB registry documents, or logs. Legacy stored URLs remain readable only
for migration compatibility and are ignored by Phase 04 verification. In
production, catalog URLs must use HTTPS, may not contain URL user information,
and are validated at startup. Development and test may use loopback HTTP RPC
fixtures. Provider failures expose only provider IDs and safe classifications,
never URLs or credentials.

### Chain identity and verification

`Chain.chainId` is the stable platform identifier used by API and persistence
references. EVM records additionally store `networkFamily: "evm"` and a
positive, safe-integer `networkChainId`, which is compared with every selected
provider's `eth_chainId` result. This separation keeps platform references
stable and avoids forcing future non-EVM adapters into an EVM numeric identity.

Creation always persists `enabled: false`. Activation and provider-selection
updates call the shared viem infrastructure from ADR 0003. Every configured
provider must be reachable, return the expected numeric chain ID, and agree.
No majority vote or first-provider fallback is permitted for registry
activation. A timeout, wrong network, malformed response, or disagreement
blocks the write with a safe `CHAIN_ERROR` response. Successful verification
records its time and increments the optimistic configuration version.

### Token verification and non-standard review

Token addresses are checksum-normalized before persistence. Activation first
requires an enabled, freshly verified parent chain and deployed bytecode at the
configured address. Every selected provider reads `decimals()`, `symbol()`, and
`totalSupply()` using the same shared viem infrastructure.

All providers must return the configured decimals and agree. A missing or
mismatched decimal result, absent bytecode, wrong chain, provider failure, or
provider disagreement is a hard activation failure and cannot be overridden.
Standard verification additionally requires the normalized configured symbol
and total supply to agree across providers.

If decimals and bytecode are valid but `symbol()` or `totalSupply()` has a
legitimate non-standard response, verification records `manual_review` and
leaves the token disabled. A later activation may proceed only with an
administrator's explicit non-standard acknowledgement and bounded reason. The
acknowledgement is accepted only after repeating live verification, may not
override any hard failure, and is captured in the append-only audit record.

Every token stores a required inbound verification policy:

- `event_only` for reviewed standard tokens whose transfer event is the
  accepted amount source.
- `balance_delta_required` when Phase 06 must verify recipient balance change
  around the containing block, including high-value or unusual tokens.

A manually approved non-standard token must use `balance_delta_required`.

### API and audit surface

Create, metadata update, activation, and deactivation are separate admin-only
commands. Generic patch bodies never contain `enabled`, raw provider URLs, or
unbounded arbitrary configuration. Every command requires a current expected
version and writes a transactional `AuditLog` entry with safe before/after
configuration, actor identity, verification classification, and any explicit
override reason. There are no registry delete routes or application delete
methods.

Normal deactivation is rejected while a non-terminal payment references the
chain or token. Force deactivation requires a literal identifier-bound
confirmation and a bounded reason. The force decision and observed open
payment count are audited loudly.

### Disable and payment-creation concurrency

Chain and token records carry an allocation sequence separate from their
administrator-facing configuration version. The registry snapshot operation
used by Phase 05 conditionally increments those sequences while the records are
enabled and writes the new payment in the same MongoDB transaction. A
deactivation transaction checks for open payments and updates the same
registry documents. This creates a database write conflict in either ordering:
deactivation sees the committed payment and refuses, or the payment snapshot
sees the disabled/version-changed registry and refuses. Redis coordination may
reduce contention later, but it is not the correctness boundary.

Phase 04 ships and concurrency-tests this snapshot repository contract. Phase
05 must use it rather than reading registry documents without a conditional
write. Payment records snapshot `requiredConfirmations` and token verification
policy; later registry changes never mutate an existing payment.

### Live refresh boundary

Phase 04 provides a versioned registry reader that returns only enabled,
verified entries and refreshes without process restart. Phase 06 uses this
reader to stop new watching promptly after a disable while retaining explicit
resolution tracking for already matched or confirming payments. Phase 04 does
not implement deposit watching or the Phase 06 chain adapter.

## Consequences

- RPC credentials remain operator-controlled even though administrators can
  select and rotate provider references.
- Activation prioritizes false negatives over trusting a disputed network or
  contract. Operators must repair provider configuration or complete the
  narrow non-standard review path rather than bypassing decimal verification.
- Configuration version and allocation sequence have separate meanings, so
  payment volume does not create spurious administrator edit conflicts.
- Existing pre-registry chain fixtures may require an additive migration or
  explicit operator backfill before activation; missing verification metadata
  is never treated as verified.
- Phase 06 reuses the Phase 04 viem clients and registry reader. It must not
  introduce a second RPC normalization or token-metadata implementation.

## Verification

- Unit tests cover provider-catalog validation, independent-operator rules,
  URL secrecy, timeouts, wrong chain IDs, provider disagreement, address/code
  checks, decimal and metadata mismatch, and manual-review classification.
- HTTP and live replica-set tests prove admin-only strict routes, transactional
  before/after audits, disabled-by-default creation, separate activation, no
  raw endpoint leakage, and no delete surface.
- Concurrent snapshot/deactivate tests prove that open payments cannot be
  introduced or orphaned without the explicit audited force operation.
- Migration and compatibility tests prove additive registry fields and indexes
  do not change migration 0001's recorded checksum.
