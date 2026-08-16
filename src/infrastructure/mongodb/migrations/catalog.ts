import { persistenceFoundationMigration } from "./0001-persistence-foundation.js";
import { registryVerificationMigration } from "./0002-registry-verification.js";
import { eventInterpretationMigration } from "./0003-event-interpretation.js";
import { paymentProcessingMigration } from "./0004-payment-processing.js";
import { complianceControlsMigration } from "./0005-compliance-controls.js";

export const databaseMigrations = [
  persistenceFoundationMigration,
  registryVerificationMigration,
  eventInterpretationMigration,
  paymentProcessingMigration,
  complianceControlsMigration,
] as const;
export const minimumCompatibleDatabaseVersion = 5;
export const maximumCompatibleDatabaseVersion = 5;
