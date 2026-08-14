# Phase 03 Validation Evidence

- Branch: `phase/03-merchant-security`
- Status: Complete
- Completed: 2026-08-14

## ADR review

Outcome: New ADR required and accepted before dependent implementation.

Reviewed sources:

- `prompt.md` merchant lifecycle, API key, tenant isolation, wallet/xpub,
  signing-material, admin auth, rate-control, webhook, audit, and production
  security requirements.
- `phases.md` fixed architectural decisions, cross-phase invariants, and Phase
  03 deliverables and validation gate.
- ADRs 0001 through 0005.

Accepted for this phase:

- ADR 0006: scrypt credential hashing, JWT and opaque refresh-token lifecycle,
  Redis fail-closed controls, repository-enforced tenant scope, BIP32 public-key
  validation, one-use wallet step-up, wallet rotation semantics, and the Phase
  03 webhook storage boundary.

## Delivered contracts

- Merchant registration, explicit email verification, admin approval,
  suspension, rejection, and lifecycle auditing use version-conditioned,
  transactional state changes.
- Merchant API keys contain 256 random secret bits, are returned only on
  approval or rotation, and persist only a random prefix plus a salted,
  versioned `scrypt` hash. Scoped rotation and revocation are transactional.
- Administrator passwords use the same reviewed hash envelope. HS256 access
  JWTs enforce key ID, issuer, audience, role, subject, session, token version,
  and expiry. Opaque 384-bit refresh tokens rotate transactionally; replay
  revokes the session family and invalidates outstanding access tokens.
- Redis atomically enforces separate login IP/identity, refresh IP/identity,
  authenticated admin, merchant authentication, and one-use step-up controls.
  Redis failure keeps protected routes closed. Rate-limit responses include
  `Retry-After`.
- Merchant-owned payment, wallet-address, wallet-configuration, and
  webhook-delivery repositories require a trusted merchant ID in every lookup.
  Foreign and missing identifiers share the same `404` response.
- Wallet onboarding accepts only operator-enabled, network-matching public
  `xpub`/`tpub` material. Private keys, xprv/tprv, WIF, PEM, mnemonic-like input,
  seed fields, and signing-material indicators are rejected before persistence
  or structured logging.
- Wallet rotation requires a short-lived, purpose-bound, one-use step-up token,
  retires the active wallet transactionally, and never changes an existing
  payment's immutable `walletAddressId`.
- Webhook URLs are strictly parsed and stored without making an outbound call.
  Phase 09 still owns destination resolution and complete SSRF enforcement.
- A one-shot administrator bootstrap command refuses to run after any admin
  exists and never prints or persists the plaintext password.
- Operator-facing auth and bootstrap procedures are documented in
  `docs/AUTHENTICATION.md` and `README.md`.

## Validation results

### Static, unit, coverage, and build gates

- `npm.cmd run validate`: passed formatting, zero-warning lint, strict type
  checking, 93 unit tests across 20 files, production build, Compose structural
  validation, and sanitized fail-closed process entrypoint checks.
- `npm.cmd run test:coverage`: passed every 80% threshold with 86.41%
  statements, 85.00% branches, 82.75% functions, and 86.41% lines.
- The HTTP security router is excluded only from the in-process unit coverage
  metric because its owning tests execute the built API in Docker. Every Phase
  03 route is exercised by the live suite below.
- `npm.cmd audit --audit-level=high`: passed online with zero vulnerabilities.
- Exact new runtime versions: `jose` 6.2.8, `@scure/bip32` 2.3.0, and
  `@noble/curves` 2.3.0.
- `git diff --check`: passed with no whitespace errors.

### Live authorization and concurrency gates

- `npm.cmd run test:integration`: 18 tests passed across 3 files without skips.
- Registration through verification and approval returned a one-time API key;
  persistence contained only its hash and prefix. Repeated approval returned no
  key.
- Missing, malformed, revoked, expired, suspended, and rejected merchant
  credentials failed closed. Merchant credentials could not access admin
  routes, and admin JWTs could not access merchant routes.
- Foreign and missing payment, credential, and wallet identifiers produced
  indistinguishable `404` envelopes with the same request ID.
- Invalid webhook credentials/fragments and malformed xpub input returned
  sanitized validation errors. Signing-material input was absent from error
  responses and persistence.
- Concurrent approval produced one credential. Concurrent credential rotation
  produced one effective replacement. Concurrent wallet rotation produced one
  active wallet, while an existing payment retained its original
  `walletAddressId`.
- Admin login, access verification, refresh rotation, refresh reuse family
  revocation, logout, and post-revocation access rejection passed against live
  MongoDB and Redis.
- The existing 12-writer audit concurrency test passed after adding bounded
  retry with jitter for MongoDB write-conflict code 112 when the transient label
  is absent.
- Integration files run serially because the Phase 02 persistence fixture
  intentionally clears all model collections during setup.

### Migration and service evidence

- Phase 02 model definitions and migration 0001 are unchanged.
- Database schema version remains `1` and migration manifest checksum remains
  `e00591dfb40834a7080dddd79aceac13c2cb9657a0769b01effd0a358b3d4e80`.
- Final application images for API, watcher, processor, scheduler, and migration
  were rebuilt from the same finalized source. The one-shot migration exited
  successfully.
- MongoDB, Redis, API, and both loopback proxies reported healthy; watcher,
  processor, and scheduler reported running.
- Live `/health` returned `ok` and `/ready` returned `ready` through
  `127.0.0.1:3000`.

### CI and security gates

- `npm.cmd run verify:ci-negative-controls`: isolated type, test, and secret
  fixtures were all rejected.
- Pinned Gitleaks 8.28.0 scanned approximately 1.16 MB across the complete final
  working tree and reported no leaks.
- A no-output API log scan found no merchant API key, JWT, xpub/tpub, PEM
  private-key, or raw 32-byte private-key patterns.
- Unit log serialization tests proved redaction of merchant keys, wallet
  step-up headers, access/refresh tokens, xpub material, and passwords.

## Defects found and corrected

- Replaced assumptions about promisified Node scrypt overloads with an explicit
  callback wrapper and added enough `maxmem` headroom for OpenSSL bookkeeping.
- Fixed invalid webhook and xpub input returning `500`; application boundaries
  now return generic `400` errors without validator details.
- Added retry handling and bounded exponential jitter for unlabeled MongoDB
  write conflicts that could starve concurrent audit writers.
- Made merchant registration and its initial audit entry atomic.
- Added an active-merchant recheck inside wallet transactions so suspension
  racing with wallet changes fails closed.
- Added explicit refresh throttling and complete credential-field log
  redaction.
- Serialized integration files after proving the earlier parallel setup could
  erase another file's live fixtures.

## Completion decision

Every Phase 03 deliverable and applicable validation gate has passed. The phase
branch is eligible for its completion commit and merge into `main`. This does
not declare the payment gateway production-ready; Phases 04 through 12 and the
final production release gates remain mandatory.
