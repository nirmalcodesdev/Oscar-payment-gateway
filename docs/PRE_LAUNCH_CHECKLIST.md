# Pre-Launch Checklist (Known Pitfalls)

This is the Known Pitfalls Checklist from the authoritative specification
(`prompt.md` §16), copied verbatim. It is a mandatory release gate: Phase 12
must verify every item below against the codebase before any go-live
decision, and no merge that un-checks an item may ship.

## 16. Known Pitfalls Checklist (explicit MUST / MUST NOT)

Use this as a pre-merge / pre-launch review checklist:

- [ ] MUST NOT use floating point for any amount, anywhere.
- [ ] MUST NOT match a deposit to a payment by amount alone on a shared
      address.
- [ ] MUST NOT trust a `Transfer` event without verifying it came from the
      configured token contract address.
- [ ] MUST NOT treat a transaction as final before `requiredConfirmations`
      is met, and MUST re-validate canonicality at that point.
- [ ] MUST NOT allow two separate code paths (e.g. "check if exists" then
      "insert") for idempotent writes — use one atomic operation.
- [ ] MUST NOT let a client control `expiresInSec` without server-side
      clamping.
- [ ] MUST NOT run MongoDB multi-document transactions against a
      standalone (non-replica-set) instance in any environment that's
      meant to resemble production behavior.
- [ ] MUST NOT assume "only one processor instance will ever run."
- [ ] MUST NOT silently drop overpayment/underpayment deltas — always
      record them.
- [ ] MUST NOT log private keys, seeds, HMAC secrets, JWTs, or full
      request bodies containing secrets.
- [ ] MUST NOT expose internal error details (stack traces, DB errors,
      RPC provider identity) in API responses.
- [ ] MUST NOT hardcode confirmation depth as one global constant across
      all chains — it's chain-specific and must be configurable.
- [ ] MUST NOT skip the "resume from last processed block" logic — a
      watcher that only listens live will silently miss deposits during
      any downtime.
- [ ] MUST verify token `decimals` against the live contract, not just a
      config value, at least at startup.
- [ ] MUST treat sanctions-screening failures (provider down) as
      "block/hold," not "allow" — fail closed.
- [ ] MUST make the `AuditLog` genuinely append-only (no update/delete
      code path).
- [ ] MUST have webhook delivery be safe to retry (merchant-side
      idempotency documented and encouraged, sender-side backoff + DLQ
      implemented).

## Release-gate usage

- Every item above must be demonstrably true at release verification
  (Phase 12), with test or audit evidence — not assumption.
- A failed item blocks go-live regardless of schedule pressure; the fixed
  architectural decisions in `phases.md` define the resolution order
  (money correctness and idempotency first).
