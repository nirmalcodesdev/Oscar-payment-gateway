# Chain and Token Registry Operations

Phase 04 provides an admin-only registry for the chains and instruments the
gateway accepts payments in. Registry entries are platform configuration;
merchants cannot create, edit, activate, or disable them.

## Instruments

A token's `assetType` is `erc20` (a deployed contract) or `native` (the
chain's gas coin, e.g. ETH/POL/BNB). `POST /api/v1/admin/tokens` defaults
to `erc20`; a native entry is created without a contract address and with its
`symbol` and `decimals` taken from the parent chain's `nativeCurrency`. There is
at most one native token per chain. Native activation verifies the chain's
numeric identity through the selected providers and cross-checks the decimals
against the chain metadata; there is no contract to read, so `manual_review`
does not apply to native tokens.

## Provider catalog

RPC endpoints are operator configuration, not API input. Set
`RPC_PROVIDER_CATALOG` to strict JSON mapping provider IDs to an operator ID and
URL. Production URLs must use HTTPS. Configure at least two providers owned by
different operators for every chain. The admin API accepts only provider IDs;
URLs are never persisted, returned, audited, or written to logs.

`RPC_REQUEST_TIMEOUT_MS` bounds every verification request. A timeout,
malformed response, unavailable provider, wrong chain ID, or disagreement is a
hard activation failure. The verifier does not select a majority or fall back to
the first provider.

## Lifecycle

Create entries disabled, then activate them as separate audited commands:

```text
POST  /api/v1/admin/chains
PATCH /api/v1/admin/chains/:chainId
POST  /api/v1/admin/chains/:chainId/activation
POST  /api/v1/admin/chains/:chainId/deactivation

POST  /api/v1/admin/tokens
PATCH /api/v1/admin/tokens/:tokenId
POST  /api/v1/admin/tokens/:tokenId/activation
POST  /api/v1/admin/tokens/:tokenId/deactivation
```

There are no registry delete routes. Every mutation requires an admin JWT and
an expected version. Chain and token projections omit provider URLs and secret
configuration. Create, update, activation, manual-review approval, and
deactivation are recorded in the append-only platform audit chain.

Chain activation verifies every selected provider at the configured numeric
EVM chain ID. Token activation reads deployed bytecode and, at one shared
block, `decimals()`, `symbol()`, and `totalSupply()`. Decimal mismatch, missing
bytecode, duplicate contract identity, and provider or chain ambiguity fail
closed. Optional `symbol()` or `totalSupply()` behavior that is consistently
non-standard is classified as `manual_review`; it never enables a token by
itself. Manual approval is available only for `balance_delta_required` tokens,
requires a bounded reason, and is separately audited.

## Disable safety

Normal deactivation is rejected while a payment is `pending`, `matched`, or
`confirming`. A force operation must include the exact literal confirmation
bound to the resource and a reason; its audit record identifies the explicit
override. Registry allocation sequences are reserved inside the payment
creation transaction, so a payment snapshot and deactivation cannot silently
cross the safety boundary.

The live registry reader refreshes without a process restart and exposes only
enabled, verified (or explicitly manual-review) tokens under enabled chains.
Already matched or confirming payments retain their snapshotted confirmation
depth and token policy.

## Migration and incident procedure

Deploy the image, run the one-shot migration with the migration identity, verify
schema version 2 and the named `uq_evm_network_chain_id` index, then start
runtime services. Runtime processes do not create indexes. Migration 0002 is
forward-only and preserves the migration 0001 checksum. Back up and verify a
restore before applying it; never edit schema metadata or delete historical
registry, payment, event, or audit records during rollback.

For a provider incident, disable affected chains or tokens through the admin
workflow, preserve the raw verification/audit evidence, and route late or
ambiguous payments to reconciliation. Do not add an emergency client-supplied
RPC URL or bypass verification.
