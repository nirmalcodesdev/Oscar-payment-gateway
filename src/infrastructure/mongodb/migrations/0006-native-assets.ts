import { createHash } from "node:crypto";

import type { Db, Document } from "mongodb";

import type { DatabaseMigration } from "./types.js";

const identifierPattern = "^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$";
const baseUnitPattern = "^(0|[1-9][0-9]*)$";
const evmAddressPattern = "^0x[0-9a-fA-F]{40}$";
const normalizedAddressPattern = "^0x[0-9a-f]{40}$";
const sha256Pattern = "^[0-9a-f]{64}$";
const transactionHashPattern = "^0x[0-9a-fA-F]{64}$";

/**
 * Migration 0006 adds the native-asset instrument (ADR 0018). The `tokens` and
 * `on_chain_events` validators are relaxed so a native token/event may omit the
 * contract address, and a native event may omit the log index (value transfers are
 * top-level transactions). The `{ chain, assetType }` partial unique index
 * limits native tokens to one per chain, and a `{ chain, transactionHash }`
 * partial unique index scoped to log-index-less rows provides exactly-once native
 * event identity. Existing rows are backfilled to `assetType: "erc20"`.
 */
const tokensValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "tokenId",
      "chain",
      "assetType",
      "symbol",
      "decimals",
      "minAmount",
      "maxAmount",
      "verificationPolicy",
      "enabled",
      "verificationStatus",
      "version",
      "allocationSequence",
    ],
    properties: {
      tokenId: { bsonType: "string", pattern: identifierPattern },
      chain: { bsonType: "string", pattern: identifierPattern },
      assetType: { enum: ["erc20", "native"] },
      symbol: { bsonType: "string", maxLength: 32 },
      contractAddress: { bsonType: "string", pattern: evmAddressPattern },
      normalizedContractAddress: {
        bsonType: "string",
        pattern: normalizedAddressPattern,
      },
      decimals: { bsonType: ["int", "long", "double"], minimum: 0, maximum: 255 },
      minAmount: { bsonType: "string", pattern: baseUnitPattern },
      maxAmount: { bsonType: "string", pattern: baseUnitPattern },
      verificationPolicy: { enum: ["event_only", "balance_delta_required"] },
      enabled: { bsonType: "bool" },
      verificationStatus: {
        enum: ["unverified", "verified", "manual_review", "failed"],
      },
      version: { bsonType: ["int", "long", "double"], minimum: 0 },
      allocationSequence: { bsonType: ["int", "long", "double"], minimum: 0 },
      verifiedAt: { bsonType: "date" },
      verifiedSymbol: { bsonType: "string", maxLength: 32 },
      verifiedDecimals: {
        bsonType: ["int", "long", "double"],
        minimum: 0,
        maximum: 255,
      },
      verifiedTotalSupply: { bsonType: "string", pattern: baseUnitPattern },
    },
  },
};

const onChainEventsValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "eventId",
      "chain",
      "assetType",
      "transactionHash",
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
      eventId: { bsonType: "string", pattern: identifierPattern },
      chain: { bsonType: "string", pattern: identifierPattern },
      assetType: { enum: ["erc20", "native"] },
      token: { bsonType: "string", pattern: identifierPattern },
      contractAddress: { bsonType: "string", pattern: evmAddressPattern },
      normalizedContractAddress: {
        bsonType: "string",
        pattern: normalizedAddressPattern,
      },
      transactionHash: { bsonType: "string", pattern: transactionHashPattern },
      logIndex: { bsonType: ["int", "long", "double", "null"] },
      blockNumber: { bsonType: ["int", "long", "double"], minimum: 0 },
      blockHash: { bsonType: "string", pattern: transactionHashPattern },
      fromAddress: { bsonType: "string", pattern: evmAddressPattern },
      normalizedFromAddress: { bsonType: "string", pattern: normalizedAddressPattern },
      toAddress: { bsonType: "string", pattern: evmAddressPattern },
      normalizedToAddress: { bsonType: "string", pattern: normalizedAddressPattern },
      amount: { bsonType: "string", pattern: baseUnitPattern },
      rawEvent: { bsonType: "object" },
      verifiedReceivedAmount: { bsonType: "string", pattern: baseUnitPattern },
      interpretationStatus: { enum: ["accepted", "rejected", "review"] },
      interpretationReason: { bsonType: "string", pattern: "^[a-z][a-z0-9_]{1,63}$" },
      interpretationRevision: { bsonType: "string", pattern: sha256Pattern },
      canonical: { bsonType: "bool" },
      confirmationsAtIngest: { bsonType: ["int", "long", "double"], minimum: 0 },
      interpretedAt: { bsonType: "date" },
    },
  },
};

const migrationManifest = JSON.stringify({
  version: 6,
  name: "native-assets-v6",
  validators: { tokens: tokensValidator, on_chain_events: onChainEventsValidator },
});

async function applyNativeAssets(db: Db): Promise<void> {
  await db
    .collection("tokens")
    .updateMany({ assetType: { $exists: false } }, { $set: { assetType: "erc20" } });
  await db
    .collection("on_chain_events")
    .updateMany({ assetType: { $exists: false } }, { $set: { assetType: "erc20" } });
  await db.command({
    collMod: "tokens",
    validator: tokensValidator,
    validationLevel: "strict",
    validationAction: "error",
  });
  await db.command({
    collMod: "on_chain_events",
    validator: onChainEventsValidator,
    validationLevel: "strict",
    validationAction: "error",
  });
}

export const nativeAssetsMigration: DatabaseMigration = {
  version: 6,
  name: "native-assets-v6",
  checksum: createHash("sha256").update(migrationManifest).digest("hex"),
  apply: applyNativeAssets,
};
