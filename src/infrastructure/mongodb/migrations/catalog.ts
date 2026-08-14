import { persistenceFoundationMigration } from "./0001-persistence-foundation.js";

export const databaseMigrations = [persistenceFoundationMigration] as const;
export const minimumCompatibleDatabaseVersion = 1;
export const maximumCompatibleDatabaseVersion = 1;
