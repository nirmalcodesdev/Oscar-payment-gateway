import { persistenceFoundationMigration } from "./0001-persistence-foundation.js";
import { registryVerificationMigration } from "./0002-registry-verification.js";
import { eventInterpretationMigration } from "./0003-event-interpretation.js";
import { paymentProcessingMigration } from "./0004-payment-processing.js";

export const databaseMigrations = [
  persistenceFoundationMigration,
  registryVerificationMigration,
  eventInterpretationMigration,
  paymentProcessingMigration,
] as const;
export const minimumCompatibleDatabaseVersion = 4;
export const maximumCompatibleDatabaseVersion = 4;
