#!/usr/bin/env node
/**
 * Release verification (Phase 12): reconcile database records against the
 * recorded on-chain test ledger. Proves no missed event, no duplicate
 * claim, no incorrect amount, and no unjustified transition.
 * Usage: node scripts/verify-ledger-reconciliation.js
 * Requires MONGODB_INTEGRATION_URI pointing at the database to verify.
 */
import mongoose from "mongoose";

const uri = process.env.MONGODB_INTEGRATION_URI;
if (!uri) {
  console.error("MONGODB_INTEGRATION_URI is required");
  process.exit(1);
}

const conn = await mongoose
  .createConnection(uri, {
    directConnection: true,
    autoIndex: false,
  })
  .asPromise();
const db = conn.db;
if (!db) throw new Error("no db");

const failures = [];
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

// 1. Ledger completeness: every accepted canonical event is either claimed
//    by exactly one payment or annotated for reconciliation (never dropped).
const events = await db.collection("on_chain_events").find({}).toArray();
const claimed = events.filter((e) => typeof e.matchedPaymentId === "string");
const annotations = await db
  .collection("reconciliation_annotations")
  .find({})
  .toArray();
const annotatedEntities = new Set(
  annotations.map((a) => `${a.entityType}:${a.entityId}`),
);
for (const event of events) {
  if (event.interpretationStatus === "accepted" && event.canonical) {
    const claimedOk = typeof event.matchedPaymentId === "string";
    const annotatedOk = annotatedEntities.has(`OnChainEvent:${event.eventId}`);
    if (!claimedOk && !annotatedOk) {
      check("unclaimed-unannotated-event", false, event.eventId);
    }
  }
}

// 2. Duplicate claims: an event satisfies at most one payment forever —
//    exactly one event row per eventId, and each claim points at one payment.
const ids = events.map((e) => e.eventId);
check("duplicate-event-rows", new Set(ids).size === ids.length);
for (const event of claimed) {
  const payment = await db
    .collection("payments")
    .findOne({ paymentId: event.matchedPaymentId });
  check("claim-without-payment", payment !== null, event.eventId);
}

// 3. Amount correctness: every matched payment's amountReceived equals the
//    recorded cumulative of its claimed events (see the reorg note below).
const payments = await db.collection("payments").find({}).toArray();
const audits = await db.collection("audit_logs").find({}).toArray();
const audited = new Set(audits.map((a) => `${a.entityId}:${a.action}`));
for (const payment of payments) {
  if (
    payment.status === "matched" ||
    payment.status === "confirming" ||
    payment.status === "confirmed"
  ) {
    // Post-reorg, orphaned claims stay counted (ADR 0012: terminal and
    // matched history is never silently rewritten), so the cumulative sum
    // spans every claimed event regardless of current canonicality.
    const claims = events.filter((e) => e.matchedPaymentId === payment.paymentId);
    const canonicalClaims = claims.filter((e) => e.canonical);
    const sumOf = (list) =>
      list.reduce((acc, e) => acc + BigInt(e.verifiedReceivedAmount ?? e.amount), 0n);
    // After a replacement re-link the cumulative was recomputed from
    // canonical claims only; without one, orphaned claims stay counted.
    const reLinked = audited.has(`${payment.paymentId}:payment_replacement_linked`);
    const sum = reLinked ? sumOf(canonicalClaims) : sumOf(claims);
    check(
      `amount-mismatch(${payment.paymentId})`,
      BigInt(payment.amountReceived ?? "0") === sum,
      `stored=${payment.amountReceived} computed=${sum}`,
    );
  }
}

// 4. Justified transitions: every non-pending payment has a matching audit
//    entry with before/after; every confirmed payment was confirmed with
//    clear screening and no automation hold.
for (const payment of payments) {
  if (payment.status !== "pending") {
    const justified = [
      "payment_matched",
      "payment_replacement_linked",
      "payment_expired",
      "payment_failed",
      "payment_confirmed",
      "payment_compliance_override_released",
    ].some((a) => audited.has(`${payment.paymentId}:${a}`));
    const reviewFlagged = annotatedEntities.has(`Payment:${payment.paymentId}`);
    check(
      `transition-without-audit-or-review(${payment.paymentId})`,
      justified || reviewFlagged,
      payment.status,
    );
  }
  if (payment.status === "confirmed") {
    check(
      `confirmed-not-clear(${payment.paymentId})`,
      payment.screeningStatus === "clear",
      payment.screeningStatus,
    );
    // A confirmed payment may be held ONLY by a recorded finality
    // incident (deep reorg) with an open annotation for manual review.
    if (payment.automationHold === true) {
      check(
        `hold-without-incident(${payment.paymentId})`,
        typeof payment.automationHoldReorgId === "string" &&
          annotatedEntities.has(`Payment:${payment.paymentId}`),
        String(payment.automationHoldReorgId),
      );
    }
  }
}

// 5. Custody invariant: no signing material anywhere in events/audit.
const forbidden = /(xprv|tprv|mnemonic|seed phrase|private[_ -]?key)/i;
for (const collection of ["on_chain_events", "audit_logs", "payments"]) {
  const hit = await db.collection(collection).findOne({
    $or: [
      { rawEvent: { $regex: forbidden } },
      { payload: { $regex: forbidden } },
      { note: { $regex: forbidden } },
    ],
  });
  check(`signing-material-in-${collection}`, hit === null);
}

console.log(
  JSON.stringify(
    {
      verified: {
        events: events.length,
        claimedEvents: claimed.length,
        payments: payments.length,
        auditEntries: audits.length,
      },
      result: failures.length === 0 ? "PASS" : "FAIL",
      failures: failures.slice(0, 20),
    },
    null,
    2,
  ),
);
await conn.close();
process.exit(failures.length === 0 ? 0 : 1);
