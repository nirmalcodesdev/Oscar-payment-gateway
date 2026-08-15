import { persistenceFoundationMigration } from "./0001-persistence-foundation.js";
import { registryVerificationMigration } from "./0002-registry-verification.js";

export const databaseMigrations = [
  persistenceFoundationMigration,
  registryVerificationMigration,
] as const;
export const minimumCompatibleDatabaseVersion = 2;
export const maximumCompatibleDatabaseVersion = 2;
