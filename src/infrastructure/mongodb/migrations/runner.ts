import { randomUUID } from "node:crypto";

import type { Connection } from "mongoose";

import { assertTransactionCapability } from "../transactions.js";
import {
  databaseMigrations,
  maximumCompatibleDatabaseVersion,
  minimumCompatibleDatabaseVersion,
} from "./catalog.js";

const leaseId = "database-schema";
const leaseDurationMs = 5 * 60 * 1000;

interface SchemaMetadata {
  readonly _id: string;
  readonly version: number;
  readonly migrations: readonly {
    version: number;
    name: string;
    checksum: string;
    appliedAt: Date;
  }[];
}

interface MigrationLease {
  readonly _id: string;
  readonly owner: string;
  readonly expiresAt: Date;
}

export class DatabaseCompatibilityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DatabaseCompatibilityError";
  }
}

function requireDatabase(connection: Connection) {
  if (connection.db === undefined) {
    throw new DatabaseCompatibilityError("MongoDB connection is not ready");
  }
  return connection.db;
}

export async function getDatabaseSchemaVersion(
  connection: Connection,
): Promise<number> {
  const metadata = await requireDatabase(connection)
    .collection<SchemaMetadata>("schema_metadata")
    .findOne({ _id: "current" });
  return metadata?.version ?? 0;
}

export async function assertDatabaseCompatibility(
  connection: Connection,
): Promise<void> {
  const version = await getDatabaseSchemaVersion(connection);
  if (
    version < minimumCompatibleDatabaseVersion ||
    version > maximumCompatibleDatabaseVersion
  ) {
    throw new DatabaseCompatibilityError(
      `Database schema version ${version} is incompatible with supported range ${minimumCompatibleDatabaseVersion}-${maximumCompatibleDatabaseVersion}`,
    );
  }
}

export async function runDatabaseMigrations(connection: Connection): Promise<number> {
  await assertTransactionCapability(connection);
  const db = requireDatabase(connection);
  const owner = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseDurationMs);
  const leases = db.collection<MigrationLease>("migration_leases");

  const lease = await leases.findOneAndUpdate(
    {
      _id: leaseId,
      $or: [{ expiresAt: { $lte: now } }, { owner }],
    },
    { $set: { owner, expiresAt } },
    { upsert: true, returnDocument: "after" },
  );
  if (lease === null || lease.owner !== owner) {
    throw new DatabaseCompatibilityError(
      "Another process owns the database migration lease",
    );
  }

  try {
    const metadataCollection = db.collection<SchemaMetadata>("schema_metadata");
    let metadata = await metadataCollection.findOne({ _id: "current" });
    let currentVersion = metadata?.version ?? 0;

    for (const migration of databaseMigrations) {
      const applied = metadata?.migrations.find(
        (item) => item.version === migration.version,
      );
      if (applied !== undefined) {
        if (
          applied.checksum !== migration.checksum ||
          applied.name !== migration.name
        ) {
          throw new DatabaseCompatibilityError(
            `Applied migration ${migration.version} does not match its catalog checksum`,
          );
        }
        continue;
      }
      if (migration.version !== currentVersion + 1) {
        throw new DatabaseCompatibilityError(
          "Migration catalog contains a version gap",
        );
      }

      await migration.apply(db);
      const appliedAt = new Date();
      await metadataCollection.updateOne(
        { _id: "current", version: currentVersion },
        {
          $setOnInsert: { _id: "current" },
          $set: { version: migration.version },
          $push: {
            migrations: {
              version: migration.version,
              name: migration.name,
              checksum: migration.checksum,
              appliedAt,
            },
          },
        },
        { upsert: currentVersion === 0 },
      );
      currentVersion = migration.version;
      metadata = await metadataCollection.findOne({ _id: "current" });
    }

    return currentVersion;
  } finally {
    await leases.deleteOne({ _id: leaseId, owner });
  }
}
