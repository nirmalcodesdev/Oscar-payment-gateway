import { createHash } from "node:crypto";

import type { Db, Document } from "mongodb";

import type { DatabaseMigration } from "./types.js";

const baseUnitPattern = "^(0|[1-9][0-9]*)$";
const sha256Pattern = "^[0-9a-f]{64}$";
const reasonPattern = "^[a-z][a-z0-9_]{1,63}$";

/**
 * Migration 0003 extends the `on_chain_events` JSON Schema validator with the
 * mutable interpretation fields introduced for Phase 06. The raw capture
 * fields and required identities from migration 0001 remain unchanged, and no
 * indexes are added, so the index-derived persistence foundation manifest
 * (ADR 0005) stays stable.
 */
const onChainEventsValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "eventId",
      "chain",
      "contractAddress",
      "normalizedContractAddress",
      "transactionHash",
      "logIndex",
      "blockNumber",
      "blockHash",
      "fromAddress",
      "normalizedFromAddress",
      "toAddress",
      "normalizedToAddress",
      "amount",
      "rawEvent",
      "canonical",
      "ingestedAt",
    ],
    properties: {
      amount: { bsonType: "string", pattern: baseUnitPattern },
      verifiedReceivedAmount: { bsonType: "string", pattern: baseUnitPattern },
      canonical: { bsonType: "bool" },
      interpretationStatus: { enum: ["accepted", "rejected", "review"] },
      interpretationReason: { bsonType: "string", pattern: reasonPattern },
      interpretationRevision: { bsonType: "string", pattern: sha256Pattern },
    },
  },
};

const migrationManifest = JSON.stringify({
  version: 3,
  name: "event-interpretation-v3",
  validators: { on_chain_events: onChainEventsValidator },
  indexes: [],
});

async function applyEventInterpretation(db: Db): Promise<void> {
  await db.command({
    collMod: "on_chain_events",
    validator: onChainEventsValidator,
    validationLevel: "strict",
    validationAction: "error",
  });
}

export const eventInterpretationMigration: DatabaseMigration = {
  version: 3,
  name: "event-interpretation-v3",
  checksum: createHash("sha256").update(migrationManifest).digest("hex"),
  apply: applyEventInterpretation,
};
