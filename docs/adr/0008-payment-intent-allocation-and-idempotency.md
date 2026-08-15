# ADR 0008: Payment Intent Allocation, Idempotency, and Destination Screening

- Status: Accepted
- Date: 2026-08-15
- Decision owner: Repository owner through the accepted Phase 05 plan
- Relates to: `REQ-03A`, `REQ-03B`, `REQ-03C`, `REQ-06`, `REQ-07`, `REQ-10`

## Context

Phase 05 creates merchant payment intents and assigns one unique receiving
address per payment from merchant-controlled extended public keys. Several
details require one durable interpretation: the exact public-only derivation
scheme, how the monotonic derivation index is allocated atomically without
colliding with wallet rotation, the lifecycle of an assigned address, the
semantics of the merchant-supplied `Idempotency-Key`, the boundary between the
Phase 05 destination-screening hook and the Phase 08 compliance provider, the
server-side expiry policy, and the exact merchant-facing response contract that
must never leak wallet, database, or provider internals.

## Decision

### Public-only address derivation

Receiving addresses are derived from the merchant's registered public extended
key using a non-hardened BIP32 child `m/<derivationIndex>` with the same
parsing, checksum, and network-validation path accepted in ADR 0006. The EVM
address is computed from the uncompressed secp256k1 child public key. The
derivation index space is `0..2^31-1` inclusive, the full non-hardened range.
No code path derives, requests, or references a hardened or private
derivation path.

### Atomic monotonic index allocation

The derivation index is allocated inside the payment creation transaction with
one conditional `findOneAndUpdate` against the active `MerchantWallet`:

- The filter requires the wallet's merchant, chain, `status: "active"`, and
  `nextDerivationIndex` within the usable range.
- The update increments only `nextDerivationIndex`. Allocation does not
  increment the wallet configuration `version`, so payment volume cannot create
  spurious rotation conflicts. Rotation races are resolved by the `status`
  condition, the partial unique active-wallet index, and transactional write
  conflicts; a payment always keeps the immutable `walletAddressId` it was
  created with.
- The final correctness boundaries are the unique indexes on
  `{ xpubId, derivationIndex }`, `{ chain, normalizedAddress }`, and the
  partial unique assigned-payment index. A duplicate-key failure on any of
  them aborts the whole transaction.

Address allocation exhaustion is a fail-closed service error with an error-level
alert log, never a silent retry, index wrap, or address reuse.

### Assigned address lifecycle

Option A creates each `WalletAddress` directly in the `assigned` state inside
the same transaction as its payment. There is no pre-allocated `available` pool
in v1. An assigned address is never reassigned, reused, or retired when its
payment expires or fails: a late transfer to that address must remain
attributable to exactly one payment forever. Wallet rotation only changes which
xpub future payments allocate from.

### Payment creation transaction

One MongoDB transaction, in order:

1. Registry snapshot reservation through the ADR 0007 conditional-write
   contract. The reservation additionally returns read-only token bounds,
   contract address, and numeric chain identity. This is an additive extension
   of the same conditional increment; Phase 05 never reads registry documents
   for payment state without that conditional write.
2. An active-merchant recheck, so suspension racing with creation fails closed.
3. Derivation index allocation and address derivation.
4. `WalletAddress` insert in `assigned` state with immutable payment reference.
5. `Payment` insert with `status: "pending"`, snapshotted confirmation depth
   and token verification policy, clamped expiry, and screening result.
6. `ComplianceScreening` record for the destination screening.
7. One merchant-scope audit entry with a safe projection. The audit contains
   identifiers and the screening verdict, never xpub or derivation metadata.
8. When an idempotency key was supplied, the `IdempotencyKey` record storing
   the exact response.

Destination screening is deterministic and local in Phase 05, so no network
input/output occurs inside the transaction. Phase 08 must keep creation-time
screening local-deterministic or move external calls ahead of the transaction
with a recorded result.

### Idempotency semantics

- The `Idempotency-Key` header is optional. A malformed key is a validation
  error, never silently ignored. Accepted keys match
  `[A-Za-z0-9._-]{16,255}`.
- The storage scope is `payment_create:<merchantId>` and the request
  fingerprint is a SHA-256 digest over the canonical sorted JSON of the
  validated request body. The authenticated merchant identity is covered by the
  scope.
- A retry with a matching fingerprint returns the stored status code and body
  without creating a second payment. A retry with a different fingerprint is an
  `IDEMPOTENCY_CONFLICT`.
- Concurrent requests with the same key collapse on the unique scope/key index.
  The losing transaction aborts, re-reads the committed record, and replays or
  conflicts. If no committed record exists, the request fails closed with a
  retryable conflict.
- Records expire through the existing idempotency TTL index using a configured
  TTL.

### Destination screening boundary

Phase 05 introduces the pluggable `SanctionsScreeningProvider` contract with
typed `clear`, `flagged`, `blocked`, `unavailable`, and `indeterminate`
verdicts, and ships a deterministic static-list implementation driven by
operator configuration containing a list version and normalized EVM addresses.
Phase 08 owns the updateable OFAC-based checker, caching policy, re-screening,
and review workflow, and must preserve this contract and its fail-closed
mapping.

Verdicts map to `Payment.screeningStatus` as `clear`, `flagged`, `blocked`, and
`pending` for unavailable or indeterminate results. The payment is created in
every case so money sent to the address remains attributable; `flagged`,
`blocked`, and `pending` are hold states that Phase 07 and Phase 08 must not
move to confirmed notification without an authorized audited resolution.
Provider errors and unknown results never approve. A screening failure that
cannot produce any verdict refuses payment creation fail-closed.

### Expiry policy

Operator configuration defines minimum, maximum, and default expiry seconds.
A client-supplied `expiresInSec` is clamped to the configured range; an absent
value uses the configured default. `expiresAt` is persisted from the clamped
value at creation time. Configuration loading rejects a minimum above the
maximum or a default outside the range.

### Merchant API contract

- `POST /api/v1/payments` requires merchant authentication and a new
  `merchant:payments` credential scope, added to the default scope set. The
  merchant identity always comes from the authenticated principal; strict body
  validation rejects any client-supplied tenant field. Payment creation is
  rate-limited per credential through the existing Redis fixed-window limiter;
  limiter dependency failure fails closed with a service-unavailable error.
- `GET /api/v1/payments/:paymentId` requires `merchant:read` and returns the
  tenant-scoped payment through the repository boundary. Missing and foreign
  identifiers remain indistinguishable `404` responses.
- Responses expose payment identity, chain/token identifiers, amount fields,
  status, screening status, expiry, rendered recipient address, EIP-681 URI,
  capped confirmations, and a confirmed boolean. Responses never expose
  `walletAddressId`, derivation index, xpub identity, database identifiers, or
  RPC/provider details.
- The read path lazily represents an unmatched `pending` payment past
  `expiresAt` as `expired` without persisting the transition. The Phase 09
  sweep owns the formal transition.
- The EIP-681 URI is `ethereum:<token contract>@<numeric chain id>/transfer?address=<recipient>&uint256=<amount>`
  with checksummed addresses and the exact base-unit integer amount.
- The Phase 03 placeholder route `/api/v1/merchant/payments/:paymentId` is
  retained unchanged so the released Phase 03 regression suite keeps passing.

### Persistence boundary

Phase 02 schemas, indexes, validators, and TTLs already cover every Phase 05
write path. No migration is required; migration 0001 and 0002 manifests and
checksums and database schema version 2 remain unchanged.

## Consequences

- Payment volume serializes per active wallet on the allocation update inside
  transactions. This is intentional; uniqueness and rotation safety take
  precedence over per-merchant allocation throughput.
- Replayed idempotent requests consume rate-limit quota. This is accepted abuse
  protection for the allocation path.
- The static-list provider is a deliberately minimal hook. It does not
  constitute a sanctions program; Phase 08 must replace or extend it with an
  updateable list and review controls before any real-funds use.
- Assigned addresses accumulate indefinitely. This is required so late
  transfers remain attributable; address growth is bounded by payment volume.
- A blocked destination creates a held payment rather than refusing the intent,
  keeping any subsequently observed transfer reconcilable.

## Verification

- Unit tests cover derivation determinism and public-only enforcement, EIP-681
  rendering, amount boundary rejection, expiry clamping, static screening
  verdicts, and idempotency fingerprint stability.
- Live replica-set tests cover transactional creation, concurrent allocation
  uniqueness, idempotent replay and conflict, tenant isolation, response
  contract redaction, lazy expiry, capped confirmations, fail-closed
  exhaustion, and held screening verdicts.
