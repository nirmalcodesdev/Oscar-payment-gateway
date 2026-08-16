import { createHash } from "node:crypto";

import type { Db, Document, IndexDescription } from "mongodb";

import type { DatabaseMigration } from "./types.js";

const identifierPattern = "^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$";
const sha256Pattern = "^[0-9a-f]{64}$";
const normalizedAddressPattern = "^0x[0-9a-f]{40}$";

/**
 * Migration 0005 adds the Phase 08 compliance collections (ADR 0013): the
 * updateable managed sanctions list with per-address entries and the
 * append-only compliance review decisions.
 */
const validators: Readonly<Record<string, Document>> = {
  sanctions_lists: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "listId",
        "listVersion",
        "source",
        "contentHash",
        "entryCount",
        "status",
        "ingestedAt",
        "version",
      ],
      properties: {
        listId: { bsonType: "string", pattern: identifierPattern },
        listVersion: { bsonType: "string", minLength: 1, maxLength: 128 },
        source: { bsonType: "string", minLength: 1, maxLength: 512 },
        contentHash: { bsonType: "string", pattern: sha256Pattern },
        entryCount: { bsonType: ["int", "long", "double"], minimum: 0 },
        status: { enum: ["active", "retired"] },
        ingestedAt: { bsonType: "date" },
        retiredAt: { bsonType: "date" },
        version: { bsonType: ["int", "long", "double"], minimum: 0 },
      },
    },
  },
  sanctions_addresses: {
    $jsonSchema: {
      bsonType: "object",
      required: ["listId", "normalizedAddress"],
      properties: {
        listId: { bsonType: "string", pattern: identifierPattern },
        normalizedAddress: {
          bsonType: "string",
          pattern: normalizedAddressPattern,
        },
      },
    },
  },
  compliance_reviews: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "reviewId",
        "paymentId",
        "decision",
        "reason",
        "reviewedBy",
        "reviewedAt",
      ],
      properties: {
        reviewId: { bsonType: "string", pattern: identifierPattern },
        paymentId: { bsonType: "string", pattern: identifierPattern },
        decision: { enum: ["release", "block"] },
        reason: { bsonType: "string", minLength: 10, maxLength: 2000 },
        evidence: { bsonType: "string", maxLength: 2000 },
        reviewedBy: { bsonType: "string", pattern: identifierPattern },
        reviewedAt: { bsonType: "date" },
      },
    },
  },
};

const indexes: Readonly<Record<string, readonly IndexDescription[]>> = {
  sanctions_lists: [
    { key: { listId: 1 }, name: "uq_sanctions_list_id", unique: true },
    {
      key: { status: 1 },
      name: "uq_sanctions_list_single_active",
      unique: true,
      partialFilterExpression: { status: "active" },
    },
    { key: { status: 1, ingestedAt: -1 }, name: "ix_sanctions_list_status_ingested" },
  ],
  sanctions_addresses: [
    {
      key: { listId: 1, normalizedAddress: 1 },
      name: "uq_sanctions_address_list_address",
      unique: true,
    },
  ],
  compliance_reviews: [
    { key: { reviewId: 1 }, name: "uq_compliance_review_id", unique: true },
    {
      key: { paymentId: 1, reviewedAt: -1 },
      name: "ix_compliance_review_payment_latest",
    },
  ],
};

/**
 * Migration 0001's screening validator is carried forward with the Phase 08
 * `verdict` field (optional so existing cache records remain valid).
 */
const complianceScreeningsValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "screeningId",
      "address",
      "normalizedAddress",
      "chain",
      "provider",
      "riskLevel",
      "sanctioned",
      "checkedAt",
      "rawResponse",
      "expiresAt",
    ],
    properties: {
      verdict: {
        enum: ["clear", "flagged", "blocked", "unavailable", "indeterminate"],
      },
      providerVersion: { bsonType: "string", maxLength: 128 },
      listVersion: { bsonType: "string", maxLength: 128 },
    },
  },
};

const migrationManifest = JSON.stringify({
  version: 5,
  name: "compliance-controls-v5",
  validators,
  indexes,
  collModValidators: { compliance_screenings: complianceScreeningsValidator },
});

async function applyComplianceControls(db: Db): Promise<void> {
  for (const [collection, validator] of Object.entries(validators)) {
    const exists = await db
      .listCollections({ name: collection }, { nameOnly: true })
      .hasNext();
    if (exists) {
      await db.command({
        collMod: collection,
        validator,
        validationLevel: "strict",
        validationAction: "error",
      });
    } else {
      await db.command({
        create: collection,
        validator,
        validationLevel: "strict",
        validationAction: "error",
      });
    }
    await db.collection(collection).createIndexes([...(indexes[collection] ?? [])]);
  }
  await db.command({
    collMod: "compliance_screenings",
    validator: complianceScreeningsValidator,
    validationLevel: "strict",
    validationAction: "error",
  });
}

export const complianceControlsMigration: DatabaseMigration = {
  version: 5,
  name: "compliance-controls-v5",
  checksum: createHash("sha256").update(migrationManifest).digest("hex"),
  apply: applyComplianceControls,
};
