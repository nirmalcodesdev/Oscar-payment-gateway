# ADR 0004: Service Foundation and Process Boundaries

- Status: Accepted
- Date: 2026-08-13
- Decision owner: Repository owner through the accepted Phase 01 plan
- Relates to: `REQ-00`, `REQ-01`, `REQ-02`, `REQ-06`, `REQ-07`, `REQ-15`

## Context

Phase 01 must establish a production-oriented Node.js foundation without
prematurely implementing later payment behavior. The API, chain watcher, event
processor, and scheduler have different scaling, failure, and restart
characteristics. Financial correctness also depends on MongoDB transactions,
durable Redis-backed jobs, strict configuration, and a non-custodial trust
boundary from the first executable code.

## Decision

The repository uses one strict TypeScript package with four independently
runnable process entry points:

- `api`: owns HTTP request handling and dependency readiness reporting.
- `watcher`: owns chain observation and durable event ingestion in later phases.
- `processor`: owns queued event interpretation and state transitions later.
- `scheduler`: owns recurring expiry, confirmation, screening, and maintenance
  jobs later.

All entry points compose dependencies explicitly from shared domain,
application, interface, and infrastructure modules. Importing a module must not
open sockets, connect to databases, start timers, or register signal handlers.
Only the process bootstrap layer may perform those side effects.

The development Compose topology keeps API, MongoDB, Redis, watcher, processor,
scheduler, and replica-set initialization on an internal-only backend network.
Docker does not publish host ports for containers attached only to an internal
network. Therefore loopback development access to API and MongoDB is provided
by two fixed-destination TCP proxy containers. Each proxy has one configured
service/port destination, runs as a non-root user with a read-only filesystem,
drops all Linux capabilities, and disables privilege escalation. Only these
proxies join the host-access bridge and only they publish loopback ports. They
are development adapters, not an authorization or production ingress layer.

Every process:

- Parses and validates the complete environment before opening dependencies.
- Connects to MongoDB configured as a replica set and Redis with bounded startup
  behavior.
- Registers `SIGINT` and `SIGTERM` once, stops accepting work, drains/closes
  owned resources in reverse order, and exits non-zero when startup or shutdown
  fails.
- Uses structured logging and a consistent error representation without
  leaking stack traces or dependency details to non-development clients.

MongoDB is the source of truth for money-equivalent state and database-enforced
uniqueness. Redis/BullMQ provides durable work delivery and coordination but is
not the final correctness boundary. Correctness-critical multi-document writes
require a replica set and transactions; configuration rejects a MongoDB URI
without an explicit replica-set selection.

The service remains non-custodial. Option A is fixed: a unique receiving address
per payment will be derived later from a merchant-controlled extended public
key using an atomic monotonic index. No process accepts or holds a receiving
private key, mnemonic, seed, or signing material.

viem remains the only chain library. In accordance with ADR 0003, Phase 04 owns
the first shared provider/contract-verification implementation and Phase 06
composes it into the watcher adapter. Phase 01 establishes interfaces and
dependency direction only; it does not create a competing RPC client.

## Threat assumptions

- Public and merchant HTTP input is hostile and tenant identifiers are never
  trusted from request bodies.
- Internal networks and queues reduce exposure but are not trusted as proof of
  authenticity; later phases add HMAC replay protection and network controls.
- RPC providers can be unavailable, inconsistent, stale, or malicious.
- Workers overlap during deploys, retries, autoscaling, and crash recovery.
- Processes can stop between any two operations, so state transitions require
  atomic database guards and replayable input.
- Logs, error responses, telemetry, environment examples, and CI artifacts are
  potential secret-exposure channels.

## Consequences

- A single repository and dependency graph reduces version drift while process
  entry points remain separately deployable and scalable.
- Later phases add behavior behind established interfaces instead of coupling
  business logic to Express, Mongoose, BullMQ, Redis, or viem.
- Local and production-like MongoDB must run as a replica set. A standalone
  MongoDB is deliberately unsupported for correctness testing.
- Host development access does not require putting core services on an
  internet-routed bridge; fixed proxies preserve the internal backend boundary
  while keeping documented loopback commands functional.
- Redis loss may pause work but must not permit duplicate financial credit once
  Phase 07 database invariants exist.
- Process-local graceful shutdown is necessary but never substitutes for queue
  idempotency, leases, conditional writes, or replay.

## Verification

- Type checking proves layer contracts and all four entry points compile.
- Unit tests verify strict configuration, consistent error envelopes, and
  graceful resource shutdown ordering/idempotence.
- Integration tests prove a MongoDB transaction commits and rolls back against
  the documented replica-set environment.
- Each process can start with valid dependencies and terminate cleanly.
- Container and CI definitions keep the four runtime commands independent.
- Structural and live topology checks prove only hardened proxy containers own
  the loopback bindings while core services remain internal-only.
