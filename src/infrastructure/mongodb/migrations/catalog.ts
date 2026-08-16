import { persistenceFoundationMigration } from "./0001-persistence-foundation.js";
import { registryVerificationMigration } from "./0002-registry-verification.js";
import { eventInterpretationMigration } from "./0003-event-interpretation.js";

export const databaseMigrations = [
  persistenceFoundationMigration,
  registryVerificationMigration,
  eventInterpretationMigration,
] as const;
export const minimumCompatibleDatabaseVersion = 3;
export const maximumCompatibleDatabaseVersion = 3;
