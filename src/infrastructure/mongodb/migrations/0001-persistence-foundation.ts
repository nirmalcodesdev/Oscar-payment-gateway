import { createHash } from "node:crypto";

import type { Db, Document, IndexDescription } from "mongodb";

import { modelDefinitions } from "../models.js";
import type { DatabaseMigration } from "./types.js";

const baseUnitPattern = "^(0|[1-9][0-9]*)$";
const positiveBaseUnitPattern = "^[1-9][0-9]*$";

const validators: Readonly<Record<string, Document>> = {
  payments: {
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
      },
    },
  },
  wallet_addresses: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "walletAddressId",
        "merchantId",
        "chain",
        "address",
        "normalizedAddress",
        "xpubId",
        "derivationIndex",
        "status",
      ],
      properties: {
        derivationIndex: { bsonType: ["int", "long", "double"], minimum: 0 },
        status: { enum: ["available", "assigned", "retired"] },
      },
    },
  },
  on_chain_events: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "eventId",
        "chain",
        "token",
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
        canonical: { bsonType: "bool" },
      },
    },
  },
  audit_logs: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "auditId",
        "scope",
        "sequence",
        "entityType",
        "entityId",
        "action",
        "actorType",
        "actorId",
        "occurredAt",
        "hashVersion",
        "previousHash",
        "entryHash",
      ],
      properties: {
        hashVersion: { enum: [1] },
        actorType: { enum: ["merchant", "admin", "system"] },
      },
    },
  },
};

async function ensureCollection(
  db: Db,
  name: string,
  validator?: Document,
): Promise<void> {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) {
    await db.createCollection(name, {
      ...(validator === undefined ? {} : { validator }),
      validationLevel: "strict",
      validationAction: "error",
    });
    return;
  }
  if (validator !== undefined) {
    await db.command({
      collMod: name,
      validator,
      validationLevel: "strict",
      validationAction: "error",
    });
  }
}

function schemaIndexes(name: string): IndexDescription[] {
  const definition = Object.values(modelDefinitions).find(
    (schema) => schema.get("collection") === name,
  );
  if (definition === undefined) return [];
  return definition
    .indexes()
    .map(([key, options]) => ({ key, ...options }) as unknown as IndexDescription);
}

async function applyPersistenceFoundation(db: Db): Promise<void> {
  for (const schema of Object.values(modelDefinitions)) {
    const collectionName = schema.get("collection");
    if (typeof collectionName !== "string") {
      throw new Error("Persistence schema is missing an explicit collection name");
    }
    await ensureCollection(db, collectionName, validators[collectionName]);
    const indexes = schemaIndexes(collectionName);
    if (indexes.length > 0) await db.collection(collectionName).createIndexes(indexes);
  }
}

function buildMigrationManifest(): string {
  const indexes: Record<string, IndexDescription[]> = {};
  for (const schema of Object.values(modelDefinitions)) {
    const collectionName: unknown = schema.get("collection");
    if (typeof collectionName !== "string") {
      throw new Error("Persistence schema is missing an explicit collection name");
    }
    indexes[collectionName] = schemaIndexes(collectionName);
  }

  return JSON.stringify({
    version: 1,
    name: "persistence-foundation-v1",
    validators,
    indexes,
  });
}

const migrationManifest = buildMigrationManifest();

export const persistenceFoundationMigration: DatabaseMigration = {
  version: 1,
  name: "persistence-foundation-v1",
  checksum: createHash("sha256").update(migrationManifest).digest("hex"),
  apply: applyPersistenceFoundation,
};
