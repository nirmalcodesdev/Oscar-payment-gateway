# ADR 0006: Identity, Tenant, and Wallet Security Boundaries

- Status: Accepted
- Date: 2026-08-14
- Decision owner: Repository owner through the accepted Phase 03 plan
- Relates to: `REQ-01`, `REQ-03A`, `REQ-03C`, `REQ-03F`, `REQ-06`, `REQ-07`,
  `REQ-09`

## Context

Phase 03 introduces credentials and authorization around records that determine
where merchant funds arrive. The specification fixes admin-approved onboarding,
one-time merchant API keys, query-layer tenant isolation, xpub-only wallet
registration, step-up reauthentication for wallet changes, and short-lived
admin JWT access with rotating refresh tokens. It leaves the cryptographic
formats, token lifecycle, rate-control boundary, xpub network source, and
repository enforcement mechanism to the implementation.

These choices must remain safe under credential theft, concurrent rotation,
guessed identifiers, stale access tokens, replayed refresh/step-up tokens, and
hostile wallet input. Phase 03 must also avoid changing the released Phase 02
migration manifest when the existing persistence contracts already contain the
required identity and wallet fields.

## Decision

### Merchant lifecycle and API keys

Merchant registration creates a `pending_approval` merchant. Email verification
is an explicit application hook and approval requires a verified email. An
authorized admin may approve, suspend, or reject a merchant; every lifecycle
change is version-conditioned and recorded in the merchant audit scope.

Approval creates a 256-bit random merchant API key. The plaintext is returned
exactly once in the approval response for controlled out-of-band delivery. The
database stores only a non-sensitive random lookup prefix and a versioned,
salted Node.js `scrypt` hash. Merchant and admin password verification use the
same reviewed hash envelope with separate random salts. Verification performs
dummy hashing when a lookup misses so unknown prefixes do not receive a cheap
timing path.

The v1 interactive `scrypt` profile is `N=65536`, `r=8`, `p=1` with a 16-byte
random salt and 64-byte derived key. The runtime memory guard allows twice the
algorithm's nominal allocation so OpenSSL bookkeeping cannot reject the
configured profile while the actual working set remains bounded by the profile.

Merchant credentials carry explicit scopes. Rotation creates the replacement
and revokes the old credential in one MongoDB transaction. Revoked, expired, or
suspended credentials fail with the same generic authentication response.

### Tenant enforcement

Merchant-owned models are accessed through repositories whose public methods
require a trusted `merchantId`. Payment, wallet address, wallet configuration,
and webhook-delivery filters always combine the tenant identifier with the
record identifier in one database query. Application services and routes do
not accept `merchantId` from merchant request bodies.

A missing record and a foreign-tenant record produce the same `NOT_FOUND`
error and response. No authorization branch performs an unscoped existence
lookup, so guessed foreign identifiers cannot change status, body, or database
query shape.

### Admin access and refresh tokens

Admin passwords use the versioned `scrypt` envelope. Access tokens are compact
JWTs signed with HS256 through `jose`, include issuer, audience, subject,
session, role, token-version, issued-at, expiry, and key ID, and expire within
15 minutes. Verification accepts only the configured current or previous key,
requires the exact algorithm/issuer/audience, and rechecks active admin,
token-version, and session state in MongoDB on every request.

Refresh tokens are 384-bit opaque random values containing a non-secret session
lookup ID. Only a SHA-256 digest is stored. Every refresh rotates to a new
session in one transaction and revokes the previous session. Reuse or a lost
concurrent rotation revokes the session family and increments the admin token
version, invalidating outstanding access tokens. Logout revokes the session.

Redis provides atomic fixed-window controls for login IP/identity attempts,
authenticated admin traffic, and merchant credentials. MongoDB credential and
session state remains the authorization source of truth; Redis unavailability
fails protected requests closed rather than disabling brute-force controls.

### Wallet registration and rotation

V1 accepts standard BIP32 public extended keys only: `xpub` for mainnet policy
and `tpub` for testnet policy. `@scure/bip32` parses the checksum and public
key, `@noble/curves` validates and decompresses the secp256k1 point, and viem
derives a sample EVM address from a non-hardened child to prove the submitted
public key is usable. Private extended keys, raw private keys,
WIF material, PEM private keys, mnemonic-like phrases, seed fields, and other
signing-material indicators are rejected before persistence or structured
logging.

The chain-to-mainnet/testnet mapping is a strict operator-controlled runtime
allowlist, never merchant input. Phase 04 must preserve or migrate this policy
when the admin chain registry gains its durable network metadata. One EVM xpub
is registered per merchant and chain; token selection reuses that chain wallet
because ERC-20 tokens on the same EVM chain share its address derivation.

Wallet mutation requires normal merchant API-key authentication plus a
short-lived, purpose-bound JWT obtained through a fresh credential
verification. The token contains merchant and credential identity, expires
within five minutes, and is consumed exactly once through Redis. Rotation
conditionally retires the current active wallet and creates the replacement in
one MongoDB transaction. Existing payments retain their immutable
`walletAddressId`; rotation affects only future allocations. Audit data stores
fingerprints and identifiers, never the xpub or derivation metadata.

### Webhook configuration boundary

Phase 03 permits authenticated merchants to store a webhook URL only after
strict URL parsing, protocol, credential, fragment, hostname, port, and length
checks. Production accepts HTTPS only. No Phase 03 component resolves or calls
the URL. Phase 09 remains responsible for the complete ADR 0002 SSRF controls
and must revalidate every delivery attempt.

## Consequences

- Compromise of stored credential rows does not reveal usable merchant API
  keys, admin passwords, refresh tokens, or wallet signing material.
- Access-token revocation has a database lookup cost; immediate suspension and
  refresh-reuse response take precedence over stateless-token optimization.
- API-key authentication is stateless, so step-up proves recent possession and
  adds one-use replay resistance but is not MFA. Operators that require MFA
  must add it before exposing wallet rotation under that policy.
- The Phase 02 schema and migration checksum remain unchanged. Phase 03 uses
  existing merchant, credential, wallet, admin-session, and audit contracts.
- MongoDB write-conflict code `112` is retried with bounded exponential jitter
  even when a server response omits the transient-transaction label. This
  prerequisite correction prevents concurrent audit writers from starving.
- Full webhook destination resolution and delivery remain blocked until Phase
  09 implements ADR 0002.

## Verification

- Unit tests cover hash envelopes, API-key parsing, JWT algorithm/key/claim
  checks, refresh rotation, replay, signing-material detection, xpub checksum
  and network mismatch, URL policy, and one-use step-up tokens.
- Live replica-set tests cover concurrent approval/credential rotation and
  wallet rotation, proving one effective active credential/wallet and no
  partial audit or retroactive payment-destination change.
- HTTP authorization tests exercise every Phase 03 route with missing,
  malformed, revoked, suspended, foreign-tenant, non-admin, expired, and
  replayed credentials and verify indistinguishable 404 behavior.
- Log and response scans assert that raw API keys, passwords, refresh/access
  tokens, xpubs, signing-material input, and foreign-tenant data are absent.
