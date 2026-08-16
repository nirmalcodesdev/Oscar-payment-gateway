# Security Statement — Oscar Payment Gateway

This document inventories exactly what secrets exist, where trust boundaries
lie, and what this system does and does not store. It is engineering
documentation; operational procedures live in `docs/runbooks/`.

## Custody model

The gateway is **non-custodial for receiving funds**. It never accepts,
stores, transmits, logs, or derives merchant private keys, seed phrases,
mnemonics, or any signing material. Deposit addresses are derived
publicly from merchant-registered extended public keys (xpub/tpub,
BIP32 public derivation only); the corresponding private keys never touch
this system.

**Future HSM/MPC boundary**: sweeps and refunds require signing capability
and are explicitly out of scope for v1. When introduced they must live in a
separate, explicitly scoped custodial component behind HSM or MPC key
management with multi-party approval — never bolted onto this service.

## Secret inventory

| Secret                            | Purpose                                                         | Stored as                                                              | Rotation                             |
| --------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| Admin JWT current/previous secret | Admin session signing (HS256, ≤15 min access, rotating refresh) | Env from secrets manager; never in DB                                  | `docs/runbooks/secret-rotation.md`   |
| Merchant step-up secret           | Wallet-change step-up tokens                                    | Env from secrets manager                                               | same                                 |
| Merchant API keys                 | Merchant authentication                                         | **Scrypt hash + lookup prefix only**; plaintext shown once at creation | Merchant self-service + admin revoke |
| Ingestion HMAC current/previous   | Watcher→API internal event signing                              | Env, both processes                                                    | versioned pair, zero-downtime        |
| Webhook HMAC current/previous     | Outbound merchant webhook signing                               | Env                                                                    | versioned pair                       |
| MongoDB / Redis credentials       | Datastore access                                                | Env connection strings                                                 | operator infrastructure              |
| RPC provider credentials          | Chain reads                                                     | Env catalog only; never in DB, API responses, or audit                 | operator with provider               |
| Sanctions provider API key        | Screening                                                       | Env                                                                    | operator with provider               |
| Admin password hashes             | Admin login                                                     | scrypt hashes in DB                                                    | admin reset flow                     |

No working credential may appear in `.env.example`, code, logs, or the
repository. Production sourcing is the secrets manager referenced by
`SECRETS_MANAGER_REFERENCE`.

## Trust boundaries

- **Internet → reverse proxy → API**: TLS terminates at the proxy
  (HTTPS-only in production; see ADR 0016 for proxy trust hops). CORS is
  an explicit origin allowlist; no CORS headers when unconfigured.
- **API → merchant clients**: per-credential scrypt API keys, scoped
  (read vs payments), Redis rate limits, tenant-scoped repositories with
  indistinguishable 404s across tenants.
- **Watcher → API (internal ingestion)**: HMAC over timestamp+nonce+exact
  bytes with replay protection, **plus** network policy — the endpoint must
  be reachable only on the private network (mTLS or VPC in production);
  HMAC alone is never a sufficient boundary (ADR 0010).
- **Gateway → merchant webhook receivers**: SSRF-hardened egress only
  (public DNS resolution, blocked private/metadata ranges, IP-pinned
  connections, no redirects, size/time bounds) under ADR 0002/0014.
- **Gateway → RPC providers**: operator-configured catalog, ≥2 independent
  operators per chain, corroboration on disagreement.
- **Processes → datastores**: MongoDB is the correctness boundary
  (replica-set transactions, conditional writes); Redis is delivery
  coordination only.

## Threat model (abridged)

- **Fund misattribution/double-credit**: mitigated by unique event claims,
  conditional versioned transitions, transactional outbox, and
  persist-before-judgment ingestion.
- **Tenant isolation break**: mitigated by repository-level scoping and
  uniform 404 envelopes; tested cross-tenant.
- **Reorg/finality violation**: mitigated by confirmation depth snapshots,
  canonicality re-checks, reorg records, and the P1 finality-incident
  automation hold.
- **SSRF via webhook URL**: mitigated by the hardened delivery client and
  creation-time URL validation (HTTPS-only, public DNS in production).
- **Secret leakage**: centralized pino redaction; raw provider payloads
  excluded from default projections; error envelopes carry no internals.
- **Screening bypass**: fail-closed verdicts; stale managed lists hold all
  payments.

## Incident reporting

Suspected security incidents (key compromise, tenant data leak,
double-credit): follow `docs/runbooks/incident-response.md` — isolate,
preserve audit chains, page the on-call owner. Report security
vulnerabilities to the repository owner's security contact; do not open
public issues for suspected exploits.

## TLS requirements

All production traffic is TLS-terminated at the reverse proxy; the app
enforces HTTPS for webhook destinations and RPC URLs in production and
expects `X-Forwarded-*` only behind the configured trust-proxy hops.
Internal service-to-service traffic rides private networks; the ingestion
endpoint additionally requires mTLS or VPC restriction.
