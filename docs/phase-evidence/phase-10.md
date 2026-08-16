# Phase 10 Validation Evidence

- Branch: `phase/10-security-observability`
- Status: Complete
- Started: 2026-08-16
- Completed: 2026-08-16

## ADR review

Outcome: New ADR required and accepted before dependent implementation.

Reviewed sources:

- `prompt.md` §9 security requirements (helmet, CORS allowlist, rate-limit
  classes, secrets hygiene, SSRF posture) and §11 observability (structured
  logs with redaction, metrics families, alerts for RPC outage, stuck
  payments, deep reorgs, screening provider outage, elevated failure rates).
- `phases.md` Phase 10 deliverables and validation gate.
- ADRs 0001 through 0015, especially ADR 0004 (process boundaries),
  ADR 0009 (provider health/failover surfacing), ADR 0010 (ingestion
  hardening), and ADR 0014 (webhook egress controls).

Accepted for this phase:

- ADR 0016: helmet baseline plus first-party explicit-origin CORS and
  hop-count proxy trust; Redis-distributed rate-limit classes with a
  documented fail-open/fail-closed split; first-party Prometheus text
  metrics with in-process counters and scrape-time database/Redis gauges;
  first-party W3C trace-context propagation on ingress, egress, and
  internal jobs without an OpenTelemetry SDK; `/health` as pure liveness
  versus `/ready` as bounded dependency readiness with per-chain provider
  and token-decimal checks that never expose provider identity; and alert
  rules as verified configuration.

## Delivered contracts

- `helmet` (HSTS, nosniff, frame-deny, referrer policy) fronts the app;
  the explicit-origin CORS middleware emits no CORS headers unless the
  configured origin matches exactly (empty configuration means an
  API-only surface); preflights from allowed origins are answered with
  the credential headers the merchant API needs.
- Proxy trust is hop-count configured (`TRUST_PROXY_HOPS`); unset means
  forwarded headers are never trusted, so a direct exposure cannot forge
  rate-limit identities.
- Rate limiting adds the app-level per-IP public class
  (`RATE_LIMIT_PUBLIC_PER_MINUTE`, Redis-distributed, fail-open with an
  error log so a Redis outage cannot drop health/metrics traffic) and the
  per-IP internal-ingestion class
  (`RATE_LIMIT_INGESTION_PER_MINUTE`) ahead of HMAC verification,
  completing the class matrix alongside the existing per-credential
  merchant, admin, and payment-creation limits.
- Error handling stays on the standardized envelope; live probes confirm
  unknown routes, malformed JSON, and validation failures never leak
  stacks, providers, or database details.
- `MetricsRegistry` renders Prometheus text with label sanitization;
  `GET /metrics` exposes in-process HTTP/ingestion counters plus
  scrape-time gauges for payment status totals, compliance holds, webhook
  dead letters, reorg records, stuck payments, queue depths by state, and
  cached readiness signals (`oscar_chain_ready`, `oscar_token_decimals_ready`).
- W3C trace context: valid incoming `traceparent` headers spawn child
  spans echoed in responses; invalid ones are replaced; the internal
  ingestion client and webhook deliveries attach trace headers.
- `/ready` now reports named check outcomes (`checks: [{name, status}]`)
  from the cached `ChainReadinessComponent`: per enabled chain at least
  one provider serving the expected network id, and per enabled token a
  corroborated live `decimals()` agreeing with configuration — chain and
  token identities only, never provider identity. `/health` remains pure
  liveness.
- `docs/alerting/prometheus-rules.yaml` defines nine alerts (readiness
  degraded, RPC outage, decimal degradation, stuck payments, deep reorg,
  elevated failure rate, queue lag, webhook dead letters, compliance
  holds) — a unit test verifies every rule expression references an
  emitted metric.
- Configuration adds `CORS_ALLOWED_ORIGINS`, `TRUST_PROXY_HOPS`,
  `RATE_LIMIT_PUBLIC_PER_MINUTE`, and `RATE_LIMIT_INGESTION_PER_MINUTE`
  (compose and `.env.example` updated).

## Validation results

### Static, unit, coverage, and build gates

- `npm run typecheck` and `npm run lint`: passed with zero warnings.
- `npm run validate`: passed formatting, strict type checking, 304 unit
  tests across 38 files, production build, Compose validation, and
  entrypoint checks.
- `npm run test:coverage`: 88.97% statements, 84.57% branches, 89.87%
  functions — every 80% threshold met.
- Phase 10 adds seven unit tests: trace-context parsing/generation, metric
  rendering with label-key quoting and injection sanitization, CORS
  allowlist reflection/preflight/denial, and alert-rule-to-metric
  verification.
- `git diff --check`: passed.

### Live Docker and integration gates

- The stack rebuilt with the hardened API: helmet headers verified live
  (`strict-transport-security`, `x-content-type-options`,
  `x-frame-options`), `/health` 200, `/ready` reporting named checks,
  `/metrics` rendering correctly labeled series
  (`oscar_payments_by_status{status="expired"}`,
  `oscar_queue_lag{queue="event-interpretation",state="waiting"}`, …).
- Live probes: disallowed origin receives no CORS headers; a valid
  `traceparent` is echoed as a child span; malformed JSON and unknown
  routes return clean envelopes with request ids.
- Full integration suite: 115 tests passed across 9 files without skips
  (all prior phase gates re-verified against the hardened stack).

### Security and operational evidence

- `npm run verify:ci-negative-controls`: rejected type, test, and secret
  fixtures.
- `npm audit --audit-level=high`: zero vulnerabilities.
- Pinned Gitleaks v8.28.0: no leaks across ~3.13 MB.
- API log scan over the hardened window: no HMAC secrets, admin JWT
  material, bearer tokens, or merchant API keys (headers redacted by the
  centralized pino redaction paths).

## Defects found and corrected

- Corrected the metrics renderer twice after live inspection: gauge series
  rendered values without label keys (`{"expired"}` instead of
  `{status="expired"}`) and empty counter series emitted one line per
  label instead of a single combined series — both now render canonical
  Prometheus text, verified live.
- Corrected the unresolvable-hostname unit test to race the resolver
  against a bounded timeout: the `.invalid` TLD can take longer than the
  default test timeout on some resolvers, stalling the suite.
- Hardened the Phase 04 suite's hermeticity: its fixed mock network id
  collided with a leftover chain from earlier suites' shared fixture once
  the database persisted across full-suite runs; the suite now clears that
  network id in `beforeAll` (later suites re-create their fixture).

## Completion decision

Every Phase 10 deliverable and applicable validation gate has passed. The
phase branch is eligible for its completion commit and merge into `main`.
This does not declare the gateway production-ready; Phases 11 through 12
and the final release gates remain mandatory.
