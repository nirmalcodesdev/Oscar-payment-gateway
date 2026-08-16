# ADR 0016: API Hardening, Observability, and Readiness

- Status: Accepted
- Date: 2026-08-16
- Decision owner: Repository owner
- Relates to: `REQ-09`, `REQ-11`

## Context

Phase 10 hardens the HTTP surface and adds operational visibility per
`prompt.md` §9 and §11: helmet security headers, an explicit CORS allowlist,
proxy/TLS trust rules, request limits, distributed endpoint-class rate
limits, standardized secret-free error envelopes, structured request logs
with centralized redaction, Prometheus metrics, trace propagation, precise
`/health` vs `/ready` semantics, and alert definitions for every
prompt-specified failure condition.

## Decision

### HTTP hardening

- `helmet` supplies the security-header baseline (HSTS, no-sniff,
  frame-deny, referrer policy); the API sets no cache headers on
  operational endpoints beyond helmet defaults.
- CORS is a first-party explicit-origin allowlist from
  `CORS_ALLOWED_ORIGINS` (empty by default: no CORS headers are emitted,
  matching an API-only/same-origin deployment). Disallowed origins receive
  no CORS headers; allowed origins receive exact reflection plus
  `Authorization` and the merchant API-key header.
- Proxy trust is hop-count configured (`TRUST_PROXY_HOPS`, unset = never
  trust proxies) so `X-Forwarded-For` cannot forge rate-limit identities
  behind a direct exposure; TLS termination guidance lives in the Phase 11
  runbook.
- Request bodies stay bounded by the existing strict 64kb JSON parser with
  raw-byte capture for HMAC; request timeouts are enforced by the HTTP
  server shutdown/handler bounds already in place.
- Rate limiting is Redis-backed (shared across replicas) with distinct
  classes: per-IP general public limit at the app layer
  (`RATE_LIMIT_PUBLIC_PER_MINUTE`), existing per-credential merchant/admin
  limits, the tighter per-credential payment-creation limit, and a per-IP
  limit on the internal ingestion endpoint
  (`RATE_LIMIT_INGESTION_PER_MINUTE`). Rate-limit unavailability fails
  closed for authenticated routes and fails open only for the general
  public limiter (a Redis outage must not take down health endpoints or
  already-authenticated flows) — the outage itself is alerted.
- Error responses keep the standardized envelope; unknown errors never
  include stacks, provider identities, or database details.

### Observability

- **Metrics**: a first-party Prometheus text registry exposes
  `GET /metrics` on the API process. In-process counters cover HTTP
  requests (status, route class) and internal ingestion outcomes;
  scrape-time gauges derive cross-process truth from MongoDB and Redis:
  payment lifecycle counts by status, compliance holds, webhook dead
  letters, event-interpretation queue depth, confirmation queue depth,
  reorg record count, and stuck-payment count. Decimal-guard and
  provider-outage conditions surface through readiness gauges.
- **Trace propagation**: W3C `traceparent` is accepted on ingress
  (validated), generated when absent, echoed in responses, propagated on
  internal ingestion and webhook egress, embedded in BullMQ job payloads,
  and restored into worker log context. This is first-party propagation
  without an OpenTelemetry SDK; exporting to a collector remains an
  operational deployment choice documented in Phase 11.
- **Logging**: pino request logs carry `requestId`, method, path, status,
  and duration; route-set context adds `paymentId`, `txHash`, `chain`, and
  `token` where applicable. Centralized redaction already covers
  authorization headers, API keys, step-up tokens, signatures, secrets,
  JWTs, and connection URIs; new headers join the redaction list.
- **Alerts**: `docs/alerting/prometheus-rules.yaml` defines rules for
  every prompt-specified condition (RPC provider down/failover,
  stuck-payment threshold, reorg deeper than confirmations, screening
  provider unreachable, elevated failed/expired rate, queue lag, webhook
  DLQ, readiness degradation). A test verifies each rule references an
  emitted metric.

### Readiness

- `/health` remains pure process liveness: no dependency checks, so a
  dependency outage never causes a liveness restart loop.
- `/ready` performs bounded checks with cached results (5 seconds for
  provider probes): MongoDB, Redis and queues, and per enabled chain at
  least one healthy provider (chain-id-level outcome only — never
  provider identity). Readiness also degrades when an enabled token's
  live `decimals()` cannot be verified or disagrees with stored
  configuration. Checks run against the enabled registry snapshot, so no
  enabled chains means no chain checks.

## Consequences

- The HTTP surface is auditable against a fixed allowlist of middleware
  and a single error envelope.
- Metrics require no new runtime dependencies; cross-process truth comes
  from the databases rather than per-process aggregation.
- Readiness provider probes are cached and bounded to keep scrapes cheap.
- Phase 11 documents the reverse-proxy TLS topology, metrics scraping,
  and alert routing that consume these surfaces.
