# Oscar Payment Gateway — Production Master Prompt

*A hardened engineering specification for building a real, production-grade
crypto payment gateway. This expands the original brief with the failure
modes, business-logic traps, and compliance obligations that actually show
up when a system like this handles real money. Use this whole document as
the prompt for the build.*

---

## 0. Role & Operating Principles

You are a senior backend architect and security engineer building a
**financial system that will hold no customer funds directly (non-custodial
by default) but whose bugs can still cause silent loss, double-crediting, or
regulatory exposure.** Treat every business rule below as a hard constraint,
not a suggestion. Where a rule conflicts with convenience or a "clever"
shortcut, the rule wins.

Non-negotiable principles, in priority order:
1. **Never lose track of money** — every on-chain event that could be a
   payment must be durably recorded before it is judged, and every judgment
   must be replayable.
2. **Never double-credit** — a given on-chain transfer may only ever satisfy
   one `Payment`, exactly once, forever, even under retries, crashes,
   duplicate deliveries, or multiple worker instances.
3. **Never trust unconfirmed chain state as final** — reorgs happen; nothing
   irreversible (webhook to merchant, "confirmed" status, sweep) fires
   before the configured confirmation depth is reached.
4. **Never trust client-supplied amounts or addresses as ground truth** —
   only on-chain data, matched against records the server itself created,
   can move a payment forward.
5. **Fail closed** — on ambiguity (unknown token contract, RPC disagreement,
   screening service down, missing decimals), stop and flag for review
   rather than guessing in the customer's favor.

---

## 1. Business Model, Scope & Regulatory Framing

**Custody model (declare explicitly in code and docs):** this system is
**non-custodial**. Customer funds move directly, on-chain, to
merchant-controlled wallet addresses. The backend never holds, transmits, or
has access to private keys for receiving funds. This distinction matters
legally (money-transmitter / VASP licensing generally attaches to
*custodial* flow of funds) and must be preserved architecturally — no code
path should ever accept, store, or transmit a private key or seed phrase for
inbound payment addresses.

**This platform is explicitly multi-tenant**: unrelated third-party
developers/merchants integrate against a shared gateway, each receiving
funds into wallets only they control (see §3.0). Every design decision
below must hold under that assumption — a bug that leaks one merchant's
data, payments, or funds destination to another merchant is as severe as
a double-credit bug and must be treated with the same priority.

**Do not silently assume this exempts the operator from regulation.**
Depending on jurisdiction and how the gateway is offered to third-party
merchants, the operator may still need to consider:
- Money Services Business (MSB) / Virtual Asset Service Provider (VASP)
  registration if the platform is deemed to be facilitating transmission
  rather than pure software provision.
- **OFAC / sanctions screening** of counterparty addresses (SDN list and
  equivalents), independent of KYC.
- **FATF Travel Rule** recordkeeping for qualifying transfer sizes if the
  operator is later classified as a VASP.
- Recordkeeping obligations for transactions above local thresholds (e.g.
  the US $3,000 BSA recordkeeping trigger).

Ship a `COMPLIANCE.md` that states these obligations exist, that the shipped
code provides *hooks* for screening/recordkeeping (§10) but not legal
sign-off, and that a licensed compliance/legal review is required before
processing real funds in any regulated jurisdiction. **The agent building
this system is not a law firm; do not have it assert legal conclusions.**

**Explicitly out of scope for v1** (state this in the README so it isn't
silently assumed later): fiat on/off-ramp, card processing, direct custody
of merchant funds, automatic conversion/settlement to fiat, tax reporting.

---

## 2. Tech Stack (expanded)

- **API**: Node.js + Express + TypeScript
- **Persistence**: MongoDB via Mongoose, **deployed as a replica set** (even
  a single-node replica set locally) — multi-document transactions and
  causal consistency are required for the idempotency/state-machine logic
  in §6 and MongoDB only supports transactions on a replica set / sharded
  cluster.
- **Chain interaction**: viem (preferred for modern EVM tooling, native
  bigint support) or ethers.js — pick one and be consistent; never mix
  BigNumber and native `bigint` math in the same module.
- **Queue / job processing**: BullMQ on Redis for event processing, retries,
  backoff, and dead-letter handling — an in-memory queue is not acceptable
  for a payments worker (§3.3 forbids it explicitly).
- **Distributed locking / leader election**: Redis (e.g. Redlock pattern)
  so multiple watcher/processor replicas don't double-process.
- **Secrets**: environment variables in dev; a real secrets manager (Vault,
  AWS/GCP KMS, or equivalent) in staging/prod. No secret ever committed,
  logged, or returned in an API response.
- **Money/amount math**: all on-chain amounts stored and computed as
  **strings representing base-unit integers** (wei / smallest unit),
  converted to `bigint` for arithmetic. **Never use `number` or floating
  point for any monetary value, anywhere, including in intermediate
  calculations, logs, or comparisons.** This is a primary source of
  real-world payment bugs.
- **Observability**: pino (structured JSON logs) + Prometheus metrics +
  OpenTelemetry tracing; Sentry (or equivalent) for exception aggregation.

---

## 3. Multi-Tenancy, Merchants & Core Business Flows (hardened)

### 3.0 Multi-Tenancy & Merchant Onboarding

This gateway is built to be integrated by unrelated third-party
developers, each running their own app/store/donation page. Model this as
a real multi-tenant system from day one — retrofitting tenant isolation
later is how cross-merchant data and funds-destination leaks happen.

**`Merchant` entity** (full schema in §4): every integrator gets a
`merchantId`, an API key pair, and a webhook endpoint. Nothing about a
merchant's configuration or activity is visible to another merchant,
ever — not payment records, not wallet addresses, not webhook delivery
status.

**Onboarding flow:**
1. Merchant registers (`POST /api/v1/merchants` — self-serve with email
   verification, or admin-approved, depending on the operator's risk
   appetite; admin-approved is the safer default given the compliance
   obligations in §1/§10).
2. Merchant receives an API key (`X-Oscar-Merchant-Api-Key`) — store only
   a salted hash of it server-side, the same way you'd store a password,
   plus a short non-sensitive prefix for admin-facing lookup/display.
3. Merchant registers where **their own** funds should land, per
   chain/token they intend to accept, using one of the two options from
   §3.1's address-allocation policy:
   - **Submits an xpub** they generated and control offline — the gateway
     derives fresh, unique receiving addresses per payment from it
     (Option A). The merchant independently holds the matching private
     key and can always re-derive and spend from those addresses with
     their own wallet software; the gateway never sees or needs the
     private key.
   - **Submits a static address** they already control (Option B), used
     with the amount-uniqueness matching scheme.
4. The gateway never accepts a private key, seed phrase, or any signing
   material from a merchant, at any step. If a submission contains
   something that looks like a private key or mnemonic, reject it — don't
   "helpfully" store it.

**Isolation is enforced at the query layer, not just the route layer:**
every `Payment`, `WalletAddress`, and webhook-related lookup must filter
by the authenticated merchant's `merchantId` — including single-record
fetches by `paymentId`. A merchant guessing or enumerating another
merchant's `paymentId` and successfully reading it back is an IDOR
vulnerability; `GET /api/v1/payments/:paymentId` must return `404` (not
`403`) if the payment doesn't belong to the authenticated merchant — don't
confirm that a record exists at all.

**Changing wallet material is a sensitive, audited action:** if a
merchant updates their registered xpub/address, this changes *where
future customer payments physically go*. Require re-authentication for
this specific action, log it to `AuditLog`, and never let it retroactively
affect already-created, still-open payment intents (they keep resolving
against the address they were created with).

**Merchants never register chains or tokens themselves** — they select
from the platform's admin-curated, verified list (§3.6). Letting a
merchant point the watcher at an arbitrary contract address they claim is
"USDC" is a direct path to fake-payment fraud.

### 3.1 Create Payment Intent — `POST /api/v1/payments`

All original fields apply, plus these business rules that close real gaps:

- **Merchant scoping**: this endpoint requires merchant authentication
  (`X-Oscar-Merchant-Api-Key`). The created `Payment.merchantId` is taken
  from the authenticated key, never from the request body — a merchant
  must never be able to create a payment on another merchant's behalf by
  passing someone else's `merchantId` as a field.
- **Amount validation**: reject amounts that are not a positive integer
  string in the token's base units, or that fall outside
  `Token.minAmount` / `Token.maxAmount` (configurable per token, not
  hardcoded — regulatory/AML thresholds and dust-attack limits both need
  this). Never accept a floating-point amount string like `"1.5"` for
  amount computation without doing exact base-unit conversion using the
  token's `decimals` field and integer math.
- **Address allocation policy — pick one explicitly and document it**:
  - **Option A (recommended): unique deposit address per payment**,
    derived from an HD wallet's *public* extended key (xpub) only, via a
    monotonic derivation index stored on `WalletAddress`. The server can
    derive addresses without ever touching a private key. This eliminates
    the "which payment does this transfer belong to" ambiguity entirely
    and is the industry-standard pattern.
  - **Option B: shared address + exact-amount matching**, only viable if
    you can guarantee no two *open* payment intents on the same
    chain/token ever have the same amount within the same address's
    pending window (requires an amount-uniqueness reservation — e.g.
    append a small random unit-of-account offset and record the exact
    expected amount).
  - Do **not** ship a design where a shared address is matched purely by
    "amount ≈ expected" — two customers paying the same round amount to
    the same address at the same time is a real collision, and openly
    reusing addresses without disambiguation is the most common design
    flaw in gateways built quickly.
- **`expiresInSec` must be clamped** server-side to a configured
  `[min, max]` (e.g. 5–120 minutes). Never trust an unbounded client value
  — an attacker requesting a year-long expiry ties up a deposit address
  indefinitely (Option A) or creates long-lived ambiguity (Option B).
- Persist `Payment` with `status: "pending"` and the **exact base-unit
  amount expected**, `requiredConfirmations` snapshotted from the current
  `Chain` config at creation time (not read live later — if the operator
  changes the config, in-flight payments should not silently change
  their finality requirement).
- Return `qrCodeData` as a properly formatted URI per chain convention
  (e.g. EIP-681 `ethereum:` URI for EVM chains) — a bare address string
  is not sufficient for wallet apps to pre-fill amount/token/chain.

### 3.2 Get Payment Status — `GET /api/v1/payments/:paymentId`

- Response must never include `recipientAddress`'s derivation path/index,
  raw `WalletAddress` internal fields, or any chain node/API endpoint
  details.
- If `status: pending` and `now > expiresAt` and no on-chain match has
  arrived, the read path should lazily reflect `expired` (in addition to
  a background sweep that formally transitions it — see §8) so a client
  polling status doesn't see a stale `pending` after the clock has
  clearly run out.
- Confirmations returned should be `min(actualConfirmations, requiredConfirmations)` with a boolean `confirmed: true/false` — don't leak raw confirmation counts that could be used to infer node/provider details, and cap the number to avoid confusion once past the threshold.

### 3.3 On-Chain Event Ingestion — `POST /api/v1/internal/on-chain-events`

- This endpoint (and the watcher that calls it) is **internal only** —
  bind it to a private network / require mTLS or a VPC in addition to the
  HMAC check; do not rely on HMAC alone as the sole boundary for something
  that can move funds-equivalent state.
- **HMAC verification must include replay protection**: sign over
  `timestamp + nonce + body`, reject requests with a timestamp skew beyond
  a small window (e.g. ±5 minutes), and record consumed nonces (short TTL
  cache) so a captured valid request can't be replayed.
- **Idempotency is enforced at the database layer, not just in
  application logic**: `eventId` has a unique index; insert with
  `insertOne` inside a try/catch for the duplicate-key error, or use
  `updateOne({eventId}, {$setOnInsert: {...}}, {upsert: true})` and check
  `upsertedCount` — never "check-then-insert" as two separate operations,
  which races.
- Store the **full raw event payload** verbatim in `OnChainEvent.rawEvent`
  before any interpretation, so mismatches can be replayed/debugged.
- **Reject events for tokens/chains not in an `enabled: true` config** —
  do not process a transfer just because it arrived; validate it against
  the `Chain`/`Token` registry first.
- **Verify the event actually originated from the configured token
  contract address**, not merely that it "looks like" a `Transfer` log —
  a malicious or fake token contract can emit an identically-shaped
  `Transfer` event to spoof a payment. Only trust events whose contract
  address matches `Token.contractAddress` for that chain/symbol.

### 3.4 Payment Confirmation Logic (state machine, precise)

**States**: `pending → matched → confirming → confirmed`, with `expired`
and `failed` as terminal off-ramps.

| From | To | Trigger | Guard |
|---|---|---|---|
| `pending` | `matched` | Qualifying on-chain event found | Payment not expired; event not already claimed by another payment |
| `matched` | `confirming` | First block observation | — |
| `confirming` | `confirming` | New block, confirmations increase | `confirmations < requiredConfirmations` |
| `confirming` | `confirmed` | Confirmation threshold reached | `confirmations >= requiredConfirmations`, txHash still canonical (no reorg since) |
| `confirming`/`matched` | `failed` | Reorg removes the matching tx and no replacement tx found before expiry+grace | — |
| `pending` | `expired` | `now > expiresAt` with no matching event ever received | — |
| any non-terminal | *(no-op)* | Any other transition attempt | **Reject** — see idempotency section |

**Matching rules, made explicit:**
- Match by `to == Payment.recipientAddress AND chain == Payment.chain AND
  token == Payment.token`. Do not match on amount alone.
- **Underpayment**: if `event.amount < Payment.amount`, do **not**
  transition to `matched`. Record the event, link it to the payment as an
  `underpayment` note, and leave the payment `pending` so a second,
  completing transfer can still arrive before expiry. Expose this in the
  status response (e.g. `partialAmountReceived`) so the merchant/customer
  UI can react. Define and document the operator's underpayment policy
  (e.g. auto-expire and flag for manual refund review) rather than leaving
  it implicit.
- **Overpayment**: if `event.amount > Payment.amount`, allow the match
  (configurable tolerance), but **record the excess explicitly** in the
  audit log and on the `Payment` document (`amountReceived` distinct from
  `amount` expected) — never silently absorb or silently drop the
  difference; it must be reconcilable.
- **Late arrival**: if a qualifying event arrives after `expiresAt` but the
  payment never received any other event, apply a configurable grace
  window (e.g. still honor it, or mark expired-but-received for manual
  reconciliation) — pick one and document it. Silently ignoring money that
  arrived late is a support/chargeback risk; silently accepting it forever
  breaks the "expiry" guarantee merchants rely on for pricing.
- **Multiple candidate payments** (Option B shared-address design only):
  if more than one open payment could match an event, this is a design
  failure per §3.1 — the system must be built so this is structurally
  impossible, not handled via priority/first-match heuristics.
- Every transition writes an `AuditLog` entry with `before`/`after` status
  and the triggering `eventId`/`txHash`.

### 3.5 Reconciliation & Admin

- `GET /api/v1/admin/reconciliation` must surface, not hide, discrepancies:
  on-chain events with no matching payment ("orphaned deposits" — money
  received that the system can't attribute; these need a manual review
  queue, not silent drop), payments stuck in `matched`/`confirming` past a
  staleness threshold, and events flagged by compliance screening (§10).
- Admin auth: JWT with `role: admin`, short expiry, refresh flow; **or**
  API key — pick one, document rotation procedure for both. Rate-limit
  admin endpoints separately (tighter) from public ones, and log every
  admin action (`AuditLog.entityType: "AdminAction"`) including the actor.


### 3.6 Admin: Chain & Token Registry Management

Chains and tokens are **platform-level, admin-only configuration** — no
merchant-facing endpoint ever creates or modifies a `Chain` or `Token`
record (see §3.0). This section defines the admin surface for managing
that registry.

**`POST /api/v1/admin/chains`** — register a new chain: `chainId`, display
name, at least two independent RPC provider URLs (§5), native currency
metadata, `requiredConfirmations` default, and `enabled: false` by default
— a newly added chain must be explicitly flipped to `enabled: true` in a
separate step after verification, never live on creation.

**`POST /api/v1/admin/tokens`** — register a new token on an existing
chain: `chain`, `symbol`, `contractAddress`, `decimals`, `minAmount`,
`maxAmount`, `enabled: false` by default. Before allowing `enabled: true`:
- Verify `decimals` against a live `decimals()` call to the contract
  itself (§5) — never trust the admin-entered value alone; mismatch
  blocks activation with a clear error.
- Verify the contract address is not already registered under a
  different symbol/chain pair (duplicate/typo-squat protection).
- Run a lightweight sanity check that the contract responds to standard
  ERC-20 read calls (`symbol()`, `decimals()`, `totalSupply()`) and flag
  for manual review if it doesn't — this is a fail-closed check, not a
  hard rejection, since some legitimate non-standard tokens exist (§5).

**`PATCH /api/v1/admin/chains/:chainId`** / **`PATCH
/api/v1/admin/tokens/:tokenId`** — update config (RPC URLs, confirmation
depth, min/max amounts, `enabled` flag). Changing `requiredConfirmations`
or `enabled` on a live chain/token must **never retroactively affect
in-flight payments** — each `Payment` snapshots its own
`requiredConfirmations` at creation time (§3.1), so this endpoint only
affects payments created after the change.

**Removing/disabling a chain or token — soft-disable only, never hard
delete:**
- There is no `DELETE` endpoint for `Chain` or `Token`. Set `enabled:
  false` instead. Historical `Payment`, `OnChainEvent`, and `ReorgRecord`
  documents reference these by id/symbol and must remain resolvable for
  audit and reconciliation (§11) indefinitely.
- Disabling a chain/token must be blocked (or require an explicit
  `force` override with a loud confirmation step) while any `Payment` on
  it is in a non-terminal state (`pending`, `matched`, `confirming`) —
  disable the ability to create *new* payments against it immediately,
  but let already-open payments resolve to a terminal state, or require
  the admin to explicitly acknowledge they're orphaning open payments.
- The watcher and event-ingestion path (§3.3) must re-check `enabled`
  status on an interval (already required in §12 for the Token registry
  re-read) — a disabled token must stop being watched for new deposits
  promptly, without a service restart, while still allowing already-
  `matched`/`confirming` payments on it to be tracked to resolution.

**Every create/update/disable action here writes an `AuditLog` entry**
(`entityType: "Chain"` / `"Token"`, actor, before/after config) per the
same discipline as other admin actions in §3.5 — a bad or malicious
config change to the chain/token registry is a direct path to fake-
payment fraud or silently breaking payment detection platform-wide, so
it gets the same audit rigor as a funds-moving action.

---

## 4. Data Model (expanded)

Keep all fields from the original brief and add:

**`Payment`** — add `amountReceived?: string`, `underpaymentFlag?: boolean`,
`overpaymentFlag?: boolean`, `version: number` (optimistic concurrency —
increment on every update, condition writes on the version you read),
`walletAddressId` (ref, not a duplicated raw address string, so rotation/
labeling stays consistent), `screeningStatus?: "clear" | "flagged" |
"blocked" | "pending"`.

**`OnChainEvent`** — add `matchedPaymentId?: string`, `canonical: boolean`
(flipped to `false` and never deleted if a reorg orphans it — see
`ReorgRecord` below; deleting rows that were once true is how audits
break), `confirmationsAtIngest?: number`.

**`ReorgRecord`** *(new)* — `{ chain, fromBlock, toBlock, detectedAt,
orphanedTxHashes: string[], affectedPaymentIds: string[], resolvedAt? }`.
Every reorg that touches a tracked address must produce one of these; it's
the audit trail for "why did a confirmed-looking payment change state."

**`IdempotencyKey`** *(new, for outbound-affecting operations like
merchant webhook delivery and admin actions)* — `{ key, scope, response,
createdAt }` with TTL index, so a retried client request (e.g. a merchant
retrying `POST /payments` with the same client-supplied idempotency key
header) returns the original result instead of creating a duplicate
payment intent.

**`ComplianceScreening`** *(new)* — `{ address, chain, provider,
riskLevel, sanctioned: boolean, checkedAt, rawResponse }`. Cache screening
results with a short TTL (screening providers update lists frequently;
don't cache indefinitely, but also don't re-screen on every single poll).

**`WalletAddress`** — add `derivationIndex?: number` (Option A),
`xpubId` (ref to the HD wallet public key record — never a private key),
`assignedPaymentId?: string`, `status: "available" | "assigned" |
"retired"`.

All models: compound indexes on the fields actually queried together
(`{chain, token, status}` on `Payment`, `{chain, contractAddress: 1,
blockNumber: 1}` on `OnChainEvent`), TTL index on expired/stale
provisional data where appropriate, and `strict: true` schemas (reject
unknown fields — don't silently accept unexpected client input into
Mongoose documents).

---

## 5. Chain Adapter Layer — Hardened Contract

```ts
interface ChainAdapter {
  chainId: string;
  init(): Promise<void>;
  getCurrentBlock(): Promise<number>;
  getConfirmations(txHash: string): Promise<number>;
  isCanonical(txHash: string, expectedBlockNumber: number): Promise<boolean>;
  watchDeposits(callback: (event: OnChainDepositEvent) => Promise<void>): void;
  stop(): Promise<void>;
}
```

Requirements beyond the interface:

- **Multi-provider redundancy**: configure at least two independent RPC
  endpoints per chain (e.g. two different providers, not two URLs from the
  same provider) with automatic failover. A single RPC outage must not
  silently stop payment detection — alert loudly if the adapter falls back
  to a secondary provider or loses connectivity entirely.
- **Poll AND catch up**: don't rely solely on a live subscription
  (`eth_subscribe` / websocket) — on reconnect or restart, the watcher
  must query `getLogs` from the **last processed block** (persisted, not
  in-memory) forward, so a restart or dropped connection never silently
  skips blocks. Track `lastProcessedBlock` per chain in the DB, updated
  only after an event batch is durably stored.
- **Reorg detection**: before treating a block as final, compare its
  parent hash against what was previously observed for that height. On
  mismatch: locate the fork point, mark affected `OnChainEvent`s
  `canonical: false`, write a `ReorgRecord`, and re-run matching against
  the new canonical blocks from the fork point forward. Payments already
  `confirmed` because they'd cleared `requiredConfirmations` before the
  fork point are — by definition of the configured depth — assumed safe;
  this is exactly why `requiredConfirmations` must be set conservatively
  per chain (deeper for chains with a history of long reorgs, e.g.
  double-digit-block reorgs have been observed on some non-mainnet EVM
  networks; near-zero for chains with fast single-slot finality).
- **Decimal/precision correctness**: read `decimals` from the `Token`
  config (verified against the live contract's `decimals()` call at
  startup, not just trusted from the DB — a mismatch here silently
  corrupts every amount comparison for that token) and do all comparisons
  in base units (`bigint`), never in human-readable float form.
- **Non-standard ERC-20 handling**: some deployed tokens (most famously
  USDT on Ethereum mainnet) don't return a boolean from `transfer`/
  `approve`/`transferFrom`, which matters if this system ever *sends*
  tokens (sweeps, refunds) — use a safe-transfer helper that tolerates a
  missing return value rather than assuming ABI-standard compliance.
  For **inbound** detection specifically: don't assume the nominal
  transfer amount is what the recipient actually received — some tokens
  implement fee-on-transfer or rebasing behavior (even if currently
  disabled on a given token, contracts can enable it later). For
  high-value tokens, verify by comparing the recipient address's
  `balanceOf` before and after the block containing the transfer, not
  just the amount encoded in the `Transfer` event log.
- **No token should be watched without an explicit `Token` registry
  entry** — never dynamically trust an arbitrary incoming ERC-20
  `Transfer` event just because it targets a watched address; only
  process events from contract addresses explicitly configured and
  enabled.

---

## 6. Idempotency, Concurrency & Exactly-Once Processing

- **Database transactions require a replica set** — call this out
  explicitly in setup docs; a common production incident is developers
  testing against a standalone MongoDB instance where `session.startTransaction()`
  silently isn't providing the guarantees they assume until it fails in
  a way that's hard to diagnose.
- **State transitions are conditional writes**, not read-modify-write:
  ```ts
  await Payment.findOneAndUpdate(
    { paymentId, status: "confirming", version: currentVersion },
    { $set: { status: "confirmed", ... }, $inc: { version: 1 } },
    { new: true }
  );
  ```
  If this returns `null`, another process already moved the state (or it's
  stale) — treat as a no-op, not an error, and don't retry-overwrite.
- **Worker concurrency**: the processor must be safe to run as N replicas
  simultaneously. Use either (a) a queue (BullMQ) with per-`eventId` job
  IDs so duplicate enqueues collapse, or (b) a Redis-based distributed
  lock keyed by `paymentId` held for the duration of a match+transition,
  or both. Never assume "only one worker will ever run" as a design
  invariant — it will not hold in production (deploys, autoscaling,
  crash-restarts all create brief multi-instance windows).
- **Outbound idempotency** (merchant webhooks, admin actions): honor a
  client-supplied `Idempotency-Key` header on `POST /api/v1/payments` at
  minimum, store the response keyed on it, and return the cached response
  on retry instead of creating a second payment intent.

---

## 7. Address & Key Management

- The backend **never stores or handles a private key for receiving
  funds**. Document, in `SECURITY.md`, exactly which keys (if any) the
  system *does* hold, where, and how (e.g. an HMAC secret in a secrets
  manager) — do not let "non-custodial" become a vague marketing claim
  that isn't backed by an explicit inventory of what secrets exist.
- If Option A (HD address-per-payment) is used, the server holds only the
  **extended public key (xpub)** needed to derive receiving addresses; the
  corresponding extended private key lives entirely outside this system
  (hardware wallet, offline signer, or a KMS/HSM/MPC custody provider if
  the operator later needs to move swept funds). Never derive or reference
  a private key path anywhere in this codebase.
- If/when a future version introduces sweeping (consolidating many
  deposit addresses into a treasury address) or refunds, that requires
  actual signing capability and is a **separate, explicitly-scoped
  custodial component** — call it out as future work requiring HSM/MPC
  key management and multi-party approval, not something to bolt onto the
  payment-detection service casually.
- Rotate and version the HMAC secret used for internal event ingestion;
  support at least a "current + previous" pair during rotation so a
  redeploy doesn't create a window where in-flight signed requests fail.

---

## 8. Background Jobs

Beyond the watcher and processor, run scheduled jobs for:
- **Expiry sweep**: periodically transition stale `pending` payments past
  `expiresAt` to `expired` (don't rely solely on lazy transition at read
  time — reconciliation and merchant-side automation need this to happen
  proactively).
- **Confirmation re-check**: for payments in `confirming`, periodically
  re-poll `getConfirmations`/`isCanonical` rather than only reacting to
  new block events, so a missed or delayed event doesn't leave a payment
  stuck.
- **Stuck-payment alerting**: flag anything in `matched`/`confirming` for
  longer than a configurable multiple of the expected confirmation time —
  this is usually the first visible symptom of an RPC outage, a reorg the
  system mishandled, or a bug.
- **Screening re-check** (§10): re-screen addresses on a schedule, since
  sanctions lists update independently of transaction activity.

---

## 9. Security Requirements (expanded)

- **Transport**: HTTPS/TLS only in any real deployment; document this as
  an infra requirement (reverse proxy termination) since the app itself
  won't enforce it.
- **Input validation**: Zod (or Joi) schemas on every endpoint, `strict`
  mode (reject unknown keys), explicit min/max bounds on every numeric or
  string field that feeds business logic (amounts, expiry, pagination
  limits).
- **HMAC replay protection** as specified in §3.3 — timestamp + nonce, not
  just signature-over-body.
- **Rate limiting**: per-IP on public endpoints, per-API-key on
  admin/merchant endpoints, tighter limits on `POST /payments` (payment
  creation is the endpoint most exposed to abuse — enumeration, spam
  address allocation, denial of service against the address pool).
- **Admin/internal auth**: RBAC via JWT roles or scoped API keys; internal
  ingestion endpoint additionally network-restricted (§3.3).
- **Secrets**: never logged, never in error responses, never in a
  committed `.env`; production secrets sourced from a secrets manager, not
  plain environment variables baked into an image.
- **CORS**: explicit allowlist of merchant/admin origins, not `*`.
- **Security headers**: helmet defaults (HSTS, no-sniff, frame-deny, etc.)
- **Dependency hygiene**: lockfile committed, `npm audit`/equivalent in
  CI, pin exact versions for chain-interaction libraries given how
  security-sensitive they are.
- **No SSRF surface**: RPC URLs and any other outbound endpoints are
  operator-configured, never accepted from a client request.

---

## 10. Compliance Layer (hooks, not legal certification)

- Define a `SanctionsScreeningProvider` interface with a pluggable
  implementation (e.g. Chainalysis, TRM Labs, Elliptic, or a self-hosted
  sanctioned-address list as a minimal fallback) that, given an address +
  chain, returns a risk verdict.
- **Screen the `to` address at payment creation** (the merchant's own
  receiving address — should normally be clean, but catches
  misconfiguration) **and the `from` address once observed on-chain**,
  before allowing a payment to progress to `confirmed`. On a `blocked`
  verdict: hold the payment in a `flagged` sub-state, do not auto-confirm,
  do not fire the merchant webhook, and surface it in the admin
  reconciliation view for manual review.
- Log every screening call and result in `ComplianceScreening` for
  recordkeeping.
- Ship this as a real interface with at least one working implementation
  (even a static OFAC SDN-list-based fallback checker) — a system that
  merely has a TODO comment for sanctions screening is not production
  ready for anything handling real transfers.
- Restate clearly in docs: this hook set supports a compliance program, it
  does not constitute one; licensing, SAR filing, and legal
  classification are outside this system's scope and require qualified
  counsel.

---

## 11. Observability & Audit

- Structured JSON logs on every request: `requestId, method, path, status,
  durationMs`, plus `paymentId`/`txHash`/`chain`/`token` where applicable.
  **Redact** amounts only if the operator's policy requires it (usually
  fine to log; never log secrets, HMAC keys, or full JWTs).
- Metrics (Prometheus-style counters/histograms): payments created,
  payments confirmed, payments expired, payments flagged, event-processing
  latency (block-seen → matched → confirmed), RPC provider failover
  count, reorg count/depth, webhook delivery success/failure.
- Alerts: RPC provider down / failed over, stuck-payment threshold
  exceeded (§8), reorg deeper than `requiredConfirmations` observed
  (means a "confirmed" payment's finality assumption was violated —
  treat as a P1), screening provider unreachable, elevated
  `failed`/`expired` rate.
- `AuditLog` is **append-only** — no update/delete API surface for it,
  ever; if you want tamper-evidence, chain each entry's hash to the
  previous entry's hash.

---

## 12. Extensibility

Keep the original factory-pattern approach for chains/tokens, and add:
- A `ChainAdapterFactory` that resolves adapters by `Chain.id`, so adding
  an EVM-compatible chain is pure configuration (RPC URL, confirmations,
  chain ID) plus, if it deviates from stock EVM behavior, a thin subclass.
- Explicitly design for eventual **non-EVM adapters** (e.g. UTXO-based or
  account-based chains with different finality models) by keeping
  `ChainAdapter` free of EVM-specific assumptions (no `blockNumber`-only
  finality logic baked into shared code — encapsulate that per-adapter).
- A `Token` registry lookup that the watcher re-reads on an interval (or
  on a config-change event) so enabling a new token doesn't require a
  restart.

---

## 13. API Contract Additions

- `GET /health` (liveness) and `GET /ready` (readiness — checks DB and at
  least one RPC provider per enabled chain) for orchestration.
- Merchant-facing **outbound webhooks** on status change: HMAC-signed
  (same discipline as §3.3, mirrored outward), retried with exponential
  backoff and jitter, moved to a dead-letter queue after N attempts with
  an admin-visible replay action. Merchants must be able to verify the
  signature and must treat delivery as at-least-once (their own handler
  needs to be idempotent on `paymentId` + `status`).
- Consistent error envelope (`VALIDATION_ERROR`, `NOT_FOUND`,
  `INTERNAL_ERROR`, `CHAIN_ERROR`, add `COMPLIANCE_HOLD`, `RATE_LIMITED`,
  `IDEMPOTENCY_CONFLICT`). No stack traces in non-dev responses.

---

## 14. Testing Strategy

- **Unit**: state machine transition table (every legal and illegal
  transition), idempotency (duplicate `eventId`, concurrent transition
  attempts), HMAC verification (valid, expired timestamp, replayed nonce,
  tampered body), amount matching (exact, under, over, decimals edge
  cases at token boundaries like 0 or max uint).
- **Integration**: run against a testnet (e.g. Sepolia) with a deployed
  test ERC-20, including a **non-standard test token** (no bool return,
  or fee-on-transfer) to exercise §5's handling.
- **Reorg simulation**: a harness that replays a block sequence with an
  injected fork, asserting the system correctly flips `canonical: false`,
  writes a `ReorgRecord`, and doesn't leave a payment in a stale
  `confirmed` state if it shouldn't be.
- **Concurrency/chaos**: run the processor as multiple instances against
  a shared event backlog and assert zero double-processing; kill/restart
  the watcher mid-stream and assert no block range is skipped.
- **Load**: sustained payment-creation rate, address-pool exhaustion
  behavior (Option A) — what happens when derivation runs ahead of what's
  been indexed for reuse.
- Document exactly how to run all of the above (`npm run test`,
  `npm run test:integration -- --network sepolia`, etc.).

---

## 15. Deployment & Ops

- Separate processes/containers: API, watcher, processor, and any
  scheduled-job runner — independently scalable and independently
  restartable.
- `.env.example` expanded from the original with: two RPC URLs per chain,
  Redis connection string, secrets-manager reference (prod), sanctions
  screening provider API key, admin JWT secret + rotation metadata,
  webhook signing secret, log level, per-chain `requiredConfirmations`
  overrides.
- Runbooks (short, in `/docs/runbooks/`): RPC provider outage, suspected
  reorg beyond configured depth, stuck-payment backlog, compliance hold
  review, secret rotation.
- Backups: MongoDB backup/restore procedure and a stated RPO/RTO target,
  even if modest for v1.

---

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

---

## 17. Deliverables

Same structural deliverables as the original brief (architecture overview,
folder structure, key source files, `.env.example`, README), plus:

- `SECURITY.md` — exact secrets inventory, key-custody model, and what is
  and isn't stored by this system.
- `COMPLIANCE.md` — regulatory framing per §1 and §10, with the explicit
  "not legal advice, get qualified review before production use with real
  funds" disclaimer.
- `docs/runbooks/*.md` per §15.
- The **Known Pitfalls Checklist** (§16) included verbatim in the repo
  (e.g. `docs/PRE_LAUNCH_CHECKLIST.md`) so it's actually used before go-live,
  not just read once.

Prioritize, in this order: correct business logic and idempotency →
security and fail-closed behavior on ambiguity → compliance hooks →
observability → clean structure → cleverness/optimization. Assume this
is headed for a real deployment handling real payments; do not take a
shortcut here that you wouldn't accept in a system moving your own money.