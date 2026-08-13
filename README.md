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
   application processes:

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
