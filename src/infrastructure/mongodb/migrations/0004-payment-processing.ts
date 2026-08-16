import { createHash } from "node:crypto";

import type { Db, Document, IndexDescription } from "mongodb";

import type { DatabaseMigration } from "./types.js";

const identifierPattern = "^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$";
const positiveBaseUnitPattern = "^[1-9][0-9]*$";
const baseUnitPattern = "^(0|[1-9][0-9]*)$";

/**
 * Migration 0004 adds the Phase 07 deep-reorg automation-hold representation
 * to `payments` (ADR 0012) and a `{chain, blockNumber}` serving index on
 * `on_chain_events` for reorg scans. The validator carries forward every
 * constraint from migration 0001; the new fields are optional so existing
 * payment documents remain valid.
 */
const paymentsValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "paymentId",
      "merchantId",
      "chain",
      "token",
      "walletAddressId",
      "amount",
      "status",
      "version",
      "requiredConfirmations",
      "screeningStatus",
      "expiresAt",
    ],
    properties: {
      amount: { bsonType: "string", pattern: positiveBaseUnitPattern },
      amountReceived: { bsonType: "string", pattern: baseUnitPattern },
      partialAmountReceived: { bsonType: "string", pattern: baseUnitPattern },
      excessAmount: { bsonType: "string", pattern: baseUnitPattern },
      version: { bsonType: ["int", "long", "double"], minimum: 0 },
      status: {
        enum: ["pending", "matched", "confirming", "confirmed", "expired", "failed"],
      },
      screeningStatus: { enum: ["clear", "flagged", "blocked", "pending"] },
      automationHold: { bsonType: "bool" },
      automationHoldReorgId: { bsonType: "string", pattern: identifierPattern },
    },
  },
};

const migrationManifest = JSON.stringify({
  version: 4,
  name: "payment-processing-v4",
  validators: { payments: paymentsValidator },
  indexes: [
    {
      key: { chain: 1, blockNumber: 1 },
      name: "ix_event_chain_block",
    },
    {
      key: { matchedPaymentId: 1 },
      name: "ix_event_payment_claim",
      partialFilterExpression: { matchedPaymentId: { $type: "string" } },
    },
  ],
});

const eventIndexes: readonly IndexDescription[] = [
  {
    key: { chain: 1, blockNumber: 1 },
    name: "ix_event_chain_block",
  },
  {
    key: { matchedPaymentId: 1 },
    name: "ix_event_payment_claim",
    partialFilterExpression: { matchedPaymentId: { $type: "string" } },
  },
];

async function applyPaymentProcessing(db: Db): Promise<void> {
  await db.command({
    collMod: "payments",
    validator: paymentsValidator,
    validationLevel: "strict",
    validationAction: "error",
  });
  const events = db.collection("on_chain_events");
  // The Phase 02 unique claim index allowed a payment to claim at most one
  // event, which cumulative partial transfers and reorg replacement re-links
  // (ADR 0011) necessarily violate. The one-event-one-payment guarantee is
  // structural: `matchedPaymentId` is a single scalar written only through
  // conditional claims. Replace it with a serving index for claim queries.
  // Tolerating IndexNotFound (code 27) keeps the migration re-runnable after
  // a partially applied attempt.
  await events.dropIndex("uq_event_payment_claim").catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === 27
    ) {
      return;
    }
    throw error;
  });
  await events.createIndexes([...eventIndexes]);
}

export const paymentProcessingMigration: DatabaseMigration = {
  version: 4,
  name: "payment-processing-v4",
  checksum: createHash("sha256").update(migrationManifest).digest("hex"),
  apply: applyPaymentProcessing,
};
