import { loadConfig } from "../config/environment.js";
import { createLogger } from "../infrastructure/logging/logger.js";
import { MongoResource } from "../infrastructure/mongodb/mongo-resource.js";
import { runDatabaseMigrations } from "../infrastructure/mongodb/migrations/runner.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, "migrate");
  const mongo = new MongoResource(config.mongodb, {
    requireSchemaCompatibility: false,
  });
  try {
    await mongo.start();
    const version = await runDatabaseMigrations(mongo.connection);
    logger.info({ databaseSchemaVersion: version }, "Database migrations complete");
  } finally {
    await mongo.stop();
  }
}

void main().catch(() => {
  process.stderr.write(
    JSON.stringify({ level: "fatal", message: "Database migration failed" }) + "\n",
  );
  process.exitCode = 1;
});
