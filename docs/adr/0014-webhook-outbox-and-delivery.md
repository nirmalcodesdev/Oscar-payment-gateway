# ADR 0014: Webhook Outbox, Signing, and SSRF-Hardened Delivery

- Status: Accepted
- Date: 2026-08-16
- Decision owner: Repository owner
- Relates to: `REQ-03E`, `REQ-08`, `REQ-09`, `REQ-02`

## Context

Phase 09 adds merchant status webhooks on top of the Phase 07/08 state
machine. `prompt.md` §8 requires at-least-once delivery, signatures over
timestamp, delivery id, and the exact body, and receiver idempotency
documentation; ADR 0002 already fixed the egress boundary: merchant webhook
URLs are the only client-configured outbound destination and must carry full
SSRF controls. The fixed webhook policy requires emission only after durable
state commits, with confirmation notifications additionally requiring
confirmation depth, canonicality, a clear compliance result, and no
automation hold. The Phase 02 `WebhookDelivery` model already reserves the
outbox shape.

## Decision

### Transactional outbox

- Webhook deliveries are written as outbox rows **inside the same replica-set
  transaction** as the payment transition and its audit entry. A committed
  transition always has its outbox row; a rolled-back transaction sends
  nothing. There is no path that writes an outbox row for an uncommitted or
  rejected transition.
- One row per `(paymentId, eventType, paymentVersion)` — the unique
  `idempotencyKey` collapses duplicates, so competing workers or replays of
  the same transition produce exactly one durable notification record.
- Emitted event types: `payment.matched`, `payment.confirmed`,
  `payment.expired`, `payment.failed`. Intermediate confirmation progress is
  not merchant-facing. `payment.confirmed` rows are written only when the
  payment has a clear screening result and no automation hold; held, blocked,
  or finality-incident payments never get confirmation notifications.
- Rows carry the full immutable payload snapshot (payment identity, status,
  amounts, timestamps, chain/token identities) so delivery never re-reads
  mutable payment state.

### Signing

- Platform-level versioned HMAC secrets (`WEBHOOK_HMAC_CURRENT_KEY_ID`/
  `_SECRET`, optional previous pair for rotation), mirroring the ingestion
  scheme: HMAC-SHA256 over `${timestamp}\n${deliveryId}\n` plus the exact
  serialized body bytes, compared nowhere in-band (receivers verify).
- Headers: `x-oscar-webhook-key-id`, `x-oscar-webhook-timestamp` (unix
  seconds), `x-oscar-delivery-id`, `x-oscar-webhook-signature`.
- Receiver guidance (documented in the README): treat `deliveryId` as the
  deduplication key and `(paymentId, eventType)` as the ordering key;
  at-least-once delivery means duplicates must be tolerated, and status
  progression must be derived by comparing the payload's `paymentVersion`.

### Delivery

- The processor runs a BullMQ worker on
  `${QUEUE_PREFIX}:webhook-delivery` with `jobId = deliveryId` (duplicate
  enqueues collapse), bounded attempts, jittered exponential backoff, and
  failed jobs retained as the dead-letter set. Enqueue happens immediately
  after the transition transaction commits; a scheduler sweep re-enqueues
  due `pending` rows whose enqueue was lost to a crash, so a crash between
  commit and enqueue cannot lose a notification.
- A delivery attempt: mark `delivering` with a conditional write, POST the
  exact payload bytes through the SSRF-hardened client, then record
  `delivered` (with response code and completion expiry) or schedule the
  next attempt; exhausted attempts mark `dead_letter`. Success is any 2xx.
- Dead-lettered rows are replayable through an audited admin endpoint that
  resets the row and re-enqueues it.

### SSRF-hardened client

- Destination is re-read from the merchant record at delivery time (not
  stale from creation) and revalidated by the creation-time rules.
- DNS is resolved manually; every resolved address must be public —
  loopback, private, link-local (including cloud metadata at
  `169.254.169.254`), CGNAT, unique-local, and reserved ranges are blocked.
  The connection is dialed to the validated IP with the original hostname
  preserved as `Host` and TLS SNI, so DNS-rebinding cannot redirect the
  actual connection to a blocked address.
- HTTPS is required outside development/test; redirects are never followed
  (3xx is a failure); requests carry a hard timeout and a bounded response
  body read.

## Consequences

- Notification loss requires losing a committed MongoDB transaction; phantom
  notifications require a transaction that never committed.
- Receivers must deduplicate; this is documented as part of the contract.
- Phase 10 metrics will count delivery success/failure and DLQ depth; the
  scheduler's sweep and the admin replay cover operational recovery.
