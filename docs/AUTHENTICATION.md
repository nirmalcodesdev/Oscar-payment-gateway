# Authentication and Merchant Isolation

Phase 03 introduces the identity boundary for the merchant and administrator
APIs. This document is an operational contract, not a production-readiness
claim; later phases still own payment creation, chain processing, compliance,
webhooks, and release certification.

## Merchant onboarding

`POST /api/v1/merchants` creates a pending merchant registration. An
administrator must record email verification and approve the merchant before
authentication is possible. Approval returns a merchant API key exactly once.
Only its random lookup prefix and salted `scrypt` hash are persisted.

Merchant requests authenticate with:

```text
X-Oscar-Merchant-Api-Key: osk_<environment>_<prefix>_<secret>
```

Keys carry explicit scopes. Rotation atomically revokes the request credential
and returns one replacement key. Suspension, rejection, expiry, revocation,
malformed keys, and unknown prefixes all return the same generic authentication
failure. API keys, passwords, JWTs, refresh tokens, and xpub material must never
be sent in URLs or logs.

## Administrator sessions

`POST /api/v1/admin/auth/login` accepts an administrator email and password and
returns a short-lived bearer access token plus an opaque rotating refresh token.
Send access tokens only in the standard header:

```text
Authorization: Bearer <access-token>
```

`POST /api/v1/admin/auth/refresh` rotates the refresh token. Reuse of a revoked
refresh token revokes its entire session family and invalidates outstanding
access tokens. `POST /api/v1/admin/auth/logout` revokes the current session.
Access-token verification rechecks the administrator, token version, and
session in MongoDB on every request. Redis unavailability fails authentication
closed and rate-limited responses include `Retry-After`.

## Wallet step-up

Initial wallet registration accepts only an operator-enabled chain and a
network-matching public `xpub` or `tpub`. Signing material is rejected before
persistence. Wallet rotation additionally requires a fresh one-use step-up
token from `POST /api/v1/merchant/auth/step-up`:

```text
X-Oscar-Wallet-Step-Up: Bearer <step-up-token>
```

The step-up token is bound to the merchant and current API credential, expires
within five minutes, and is consumed atomically in Redis. Rotation retires the
active xpub transactionally. Existing payments retain their original
`walletAddressId`; only future address allocation uses the replacement.

## Tenant boundary

Merchant request bodies never supply a trusted `merchantId`. Payment, wallet,
wallet-address, and webhook-delivery repositories combine the authenticated
merchant ID and record ID in the same query. Missing and foreign-tenant payment
identifiers return the same `404` envelope so record existence is not exposed.

Webhook configuration stores only a strictly parsed URL and performs no
network request in Phase 03. Phase 09 must revalidate destinations and enforce
the complete SSRF policy before delivery.
