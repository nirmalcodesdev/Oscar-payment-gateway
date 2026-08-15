import { createHash } from "node:crypto";

import type { Db, Document, IndexDescription } from "mongodb";

import type { DatabaseMigration } from "./types.js";

const identifierPattern = "^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$";
const positiveBaseUnitPattern = "^[1-9][0-9]*$";
const normalizedAddressPattern = "^0x[0-9a-f]{40}$";

const validators: Readonly<Record<string, Document>> = {
  chains: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "chainId",
        "networkFamily",
        "networkChainId",
        "name",
        "rpcProviders",
        "nativeCurrency",
        "requiredConfirmations",
        "enabled",
        "version",
        "allocationSequence",
      ],
      properties: {
        chainId: { bsonType: "string", pattern: identifierPattern },
        networkFamily: { enum: ["evm"] },
        networkChainId: { bsonType: ["int", "long", "double"], minimum: 1 },
        rpcProviders: {
          bsonType: "array",
          minItems: 2,
          items: {
            bsonType: "object",
            required: ["providerId", "operatorId"],
            additionalProperties: false,
            properties: {
              providerId: { bsonType: "string", pattern: identifierPattern },
              operatorId: { bsonType: "string", pattern: identifierPattern },
            },
          },
        },
        requiredConfirmations: {
          bsonType: ["int", "long", "double"],
          minimum: 1,
        },
        enabled: { bsonType: "bool" },
        version: { bsonType: ["int", "long", "double"], minimum: 0 },
        allocationSequence: {
          bsonType: ["int", "long", "double"],
          minimum: 0,
        },
      },
    },
  },
  tokens: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "tokenId",
        "chain",
        "symbol",
        "contractAddress",
        "normalizedContractAddress",
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
        normalizedContractAddress: {
          bsonType: "string",
          pattern: normalizedAddressPattern,
        },
        decimals: { bsonType: ["int", "long", "double"], minimum: 0, maximum: 255 },
        minAmount: { bsonType: "string", pattern: positiveBaseUnitPattern },
        maxAmount: { bsonType: "string", pattern: positiveBaseUnitPattern },
        verificationPolicy: {
          enum: ["event_only", "balance_delta_required"],
        },
        enabled: { bsonType: "bool" },
        verificationStatus: {
          enum: ["unverified", "verified", "manual_review", "failed"],
        },
        version: { bsonType: ["int", "long", "double"], minimum: 0 },
        allocationSequence: {
          bsonType: ["int", "long", "double"],
          minimum: 0,
        },
        verifiedTotalSupply: { bsonType: "string", pattern: "^(0|[1-9][0-9]*)$" },
      },
    },
  },
};

const migrationManifest = JSON.stringify({
  version: 2,
  name: "registry-verification-v2",
  validators,
  indexes: [
    {
      key: { networkFamily: 1, networkChainId: 1 },
      name: "uq_evm_network_chain_id",
      unique: true,
      partialFilterExpression: { networkFamily: "evm" },
    },
  ],
});

const registryIndexes: readonly IndexDescription[] = [
  {
    key: { networkFamily: 1, networkChainId: 1 },
    name: "uq_evm_network_chain_id",
    unique: true,
    partialFilterExpression: { networkFamily: "evm" },
  },
];

async function applyRegistryVerification(db: Db): Promise<void> {
  for (const [collectionName, validator] of Object.entries(validators)) {
    await db.command({
      collMod: collectionName,
      validator,
      validationLevel: "strict",
      validationAction: "error",
    });
  }
  await db.collection("chains").createIndexes([...registryIndexes]);
}

export const registryVerificationMigration: DatabaseMigration = {
  version: 2,
  name: "registry-verification-v2",
  checksum: createHash("sha256").update(migrationManifest).digest("hex"),
  apply: applyRegistryVerification,
};
