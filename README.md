# Oscar Payment Gateway

Oscar Payment Gateway is a production-oriented, multi-tenant cryptocurrency
payment gateway. The v1 architecture is non-custodial: customer funds move
directly to merchant-controlled on-chain addresses. This service must never
accept, store, transmit, log, or derive a receiving private key, mnemonic, seed
phrase, or other signing material.

The project is under active implementation. It is not ready to process real
funds until every phase in `phases.md`, the security and compliance reviews, and
the production release gates have completed successfully.

## v1 scope

The service will create merchant-scoped payment intents, derive unique deposit
addresses from merchant-controlled extended public keys, ingest and reconcile
configured on-chain token transfers, wait for chain-specific finality, screen
addresses, and deliver signed merchant webhooks.

The following are explicitly out of scope for v1:

- Fiat on-ramp or off-ramp services.
- Card processing.
- Direct custody of merchant or customer funds.
- Automatic conversion or settlement to fiat.
- Tax reporting.
- Sweeps, refunds, or any signing service.

## Processes

The codebase produces four independently runnable processes:

| Process   | Command                   | Responsibility                          |
| --------- | ------------------------- | --------------------------------------- |
| API       | `npm run start:api`       | HTTP API, liveness, and readiness       |
| Watcher   | `npm run start:watcher`   | Chain observation and durable ingestion |
| Processor | `npm run start:processor` | Queued event processing and transitions |
| Scheduler | `npm run start:scheduler` | Recurring operational jobs              |

Phase 01 establishes process and dependency lifecycles. Payment behavior is
added only in its owning later phase.

## Prerequisites

- Node.js 24.x and npm 11.x.
- Docker with Compose v2 for the production-like local dependency topology.

MongoDB must run as a replica set. Standalone MongoDB is unsupported because it
cannot provide the transaction guarantees required by the payment state
machine.

## Local setup

1. Copy the inert development settings from `.env.example` into a local `.env`
   and replace values only as needed. `.env` is ignored by Git.
2. Install exact dependencies:

   ```text
   npm ci
   ```

3. Start MongoDB, initialize the replica set, start Redis, and start all four
   application processes. Compose runs the one-shot database migration with a
   separate local migration identity before any runtime process starts:

   ```text
   docker compose up --build --wait
   ```

4. Verify the API:

   ```text
   GET http://127.0.0.1:3000/health
   GET http://127.0.0.1:3000/ready
   ```

`/health` reports process liveness. `/ready` reports whether required
dependencies are ready and returns `503` when they are not.

The application and dependency containers remain on an internal-only Compose
network. Hardened fixed-destination proxy containers provide the documented
loopback API and MongoDB ports for local development; the proxies run non-root,
read-only, with all Linux capabilities dropped. They are not a production
ingress or authentication boundary.

The credentials and MongoDB key file in `compose.yaml` are fixed local-only
development material. They must never be reused in staging or production.

Production migrations are an explicit deployment step and use a database
identity that is never mounted into runtime services. Runtime startup rejects
an incompatible database version and keeps automatic index creation disabled.
See `docs/PERSISTENCE.md` for deployment, least-privilege, validation, and
rollback procedures.

## Initial administrator

After migrations complete, an operator can create the first administrator with
the one-shot `npm run bootstrap:admin` command. Inject
`ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` only for that command;
the password must contain at least 16 characters and must come from the
deployment secret manager. The command stores only a salted password hash,
does not print the password, and refuses to run after any administrator exists.
Remove both bootstrap variables from the process environment immediately after
the command completes.

Merchant and administrator authentication, key rotation, wallet step-up, and
the Phase 03 route contracts are documented in `docs/AUTHENTICATION.md`.

## Chain and token registry

Phase 04 adds the admin-only, audited chain and ERC-20 registry. Entries are
created disabled and activated only after live verification through the
operator-configured `RPC_PROVIDER_CATALOG`; administrators submit provider IDs,
never RPC URLs. Configure at least two providers operated independently for
each chain. The registry never stores or returns endpoint credentials. See
`docs/REGISTRY.md` for lifecycle, manual-review, deactivation, and migration
procedures.

## Validation

```text
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm audit --audit-level=high
```

Run replica-set integration tests after the Compose dependencies are healthy:

```text
MONGODB_INTEGRATION_URI=mongodb://oscar_app:local-app-password@127.0.0.1:27017/oscar_payment_gateway?authSource=admin&replicaSet=rs0&directConnection=true npm run test:integration
```

On PowerShell systems that block `npm.ps1`, run the same commands with
`npm.cmd`.

## Specification and decisions

- `prompt.md` is the authoritative v1 specification.
- `phases.md` is the implementation and verification plan.
- `AGENTS.md` defines mandatory contribution and phase controls.
- Accepted architectural decisions are in `docs/adr/`.

## License

No open-source license has been granted. The repository is currently marked
`UNLICENSED`; all rights are reserved until the owner records a different
license decision.

## Architecture overview

Clean-architecture layering with dependencies pointing inward:

```
src/domain         Pure contracts: state machines, chain ports, money,
                   screening, error envelopes
src/application    Services: payment creation, matching, confirmation,
                   ingestion/interpretation, compliance, scheduling,
                   reconciliation, webhooks
src/infrastructure MongoDB (replica-set transactions, hash-chained audit),
                   viem RPC clients, BullMQ/Redis queues and locks,
                   scrypt/HMAC/JWT auth, SSRF-hardened HTTP clients,
                   metrics, trace propagation
src/interfaces/http Express app + routers (merchant, admin, compliance,
                   reconciliation, internal ingestion)
src/processes      Four entry points: api, watcher, processor, scheduler
```

Key invariants: MongoDB is the correctness boundary (unique event claims,
conditional versioned transitions, transactional webhook outbox); Redis is
delivery coordination only; all money is base-unit integer strings with
`bigint` arithmetic; everything ambiguous fails closed. See `docs/adr/` for
the binding decisions.

## Setup (development)

Requires Node 24, Docker, and the Compose stack (MongoDB replica set +
Redis + mock RPC providers):

```bash
npm ci
docker compose up -d --build     # starts every service + migrations
docker compose ps                # wait for api (healthy)
curl http://127.0.0.1:3000/ready # {"status":"ready",...}
```

Bootstrap the initial admin identity (one-time; prints credentials once):

```bash
npm run build && npm run bootstrap:admin
```

**Replica set requirement**: every environment that resembles production
must run MongoDB as a replica set — multi-document transactions silently
fail to provide their guarantees against a standalone mongod. The Compose
stack configures `rs0` automatically.

## Process operation

| Operation                 | Command                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| Start one process (dev)   | `npm run dev:api` / `dev:watcher` / `dev:processor` / `dev:scheduler` |
| Start one process (built) | `npm run start:api` ...                                               |
| Run migrations            | `npm run build && npm run migrate`                                    |
| Graceful shutdown         | `docker compose stop <service>` (30s drain window)                    |
| Scale processors          | safe at any replica count (exactly-once by design)                    |
| Liveness / readiness      | `GET /health` (process) / `GET /ready` (dependencies + chains)        |
| Metrics                   | `GET /metrics` (Prometheus text)                                      |

Rolling restarts are safe: cursor-based watching resumes from the last
processed block; in-flight jobs retry; scheduler leases prevent overlap.

## API usage (merchant)

1. Onboard via admin approval; register a wallet xpub (public keys only).
2. Create payments: `POST /api/v1/payments` with merchant API key
   (`x-oscar-merchant-api-key`), optional `Idempotency-Key`; the response
   carries the deposit address, EIP-681 URI, and expiry.
3. Poll `GET /api/v1/payments/:paymentId` (merchant:read) for status,
   capped confirmations, and partial/overpayment fields.
4. Receive signed webhooks for matched/confirmed/expired/failed.

## Webhook verification and idempotency

Every delivery is signed with HMAC-SHA256 over
`${timestamp}\n${deliveryId}\n` + exact body bytes using the platform's
versioned key. Verify headers `x-oscar-webhook-key-id`,
`x-oscar-webhook-timestamp` (reject stale), `x-oscar-delivery-id`,
`x-oscar-webhook-signature`. Delivery is **at-least-once**: deduplicate on
`deliveryId`, derive ordering from the payload's `paymentVersion`, and
treat `(paymentId, eventType)` as the logical key. Failed deliveries retry
with jittered backoff, then dead-letter (merchant-visible via support).

## Testing commands

```bash
npm run validate       # format + lint + typecheck + unit + build + compose/entrypoint gates
npm run test:coverage  # unit coverage thresholds
MONGODB_INTEGRATION_URI="mongodb://oscar_app:local-app-password@127.0.0.1:27017/oscar_payment_gateway?authSource=admin&replicaSet=rs0&directConnection=true" \
PHASE03_API_URL="http://127.0.0.1:3000" \
npm run test:integration   # full live suite (requires the Compose stack)
npm run verify:ci-negative-controls
```

## Operations and security documentation

- `SECURITY.md` — secret inventory, trust boundaries, custody model,
  incident reporting.
- `COMPLIANCE.md` — regulatory framing (not legal advice).
- `docs/runbooks/` — RPC outage, deep reorg, backlogs, compliance holds,
  secret rotation, webhook DLQ, allocation exhaustion, data restoration
  (RPO/RTO), tenant leak, double-credit, incident response.
- `docs/alerting/prometheus-rules.yaml` — alert definitions.
- `docs/PRE_LAUNCH_CHECKLIST.md` — verbatim release gate.
- `deploy/docker-compose.production.example.yaml` — production topology
  template.

## Limitations and v1 exclusions

Single EVM family; no sweeps/refunds/signing (future HSM/MPC component);
screening is the fail-closed static-list fallback plus admin-managed lists
(integrate a real provider before real funds); webhook egress requires the
documented SSRF controls; fiat rails, tax reporting, and custody are out of
scope. This software is not production-ready until Phases 11–12 and the
pre-launch checklist complete with evidence.
