import { randomUUID } from "node:crypto";

import { loadConfig } from "../config/environment.js";
import { hashSecret } from "../infrastructure/auth/secret-hasher.js";
import { appendAuditEntryInTransaction } from "../infrastructure/mongodb/audit-service.js";
import { registerPersistenceModels } from "../infrastructure/mongodb/models.js";
import { MongoResource } from "../infrastructure/mongodb/mongo-resource.js";
import { withRequiredTransaction } from "../infrastructure/mongodb/transactions.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bootstrapInput(): { email: string; password: string } {
  const email = process.env["ADMIN_BOOTSTRAP_EMAIL"]?.trim().toLowerCase();
  const password = process.env["ADMIN_BOOTSTRAP_PASSWORD"];
  if (
    email === undefined ||
    email.length > 320 ||
    !emailPattern.test(email) ||
    password === undefined ||
    password.length < 16 ||
    password.length > 1024
  ) {
    throw new Error(
      "Valid ADMIN_BOOTSTRAP_EMAIL and a 16+ character ADMIN_BOOTSTRAP_PASSWORD are required",
    );
  }
  return { email, password };
}

async function main(): Promise<void> {
  const input = bootstrapInput();
  const config = loadConfig();
  const passwordHash = await hashSecret(input.password);
  const mongo = new MongoResource(config.mongodb);
  try {
    await mongo.start();
    const models = registerPersistenceModels(mongo.connection);
    const adminId = `admin_${randomUUID()}`;
    await withRequiredTransaction(mongo.connection, async (session) => {
      const existingCount = await models.AdminIdentity.countDocuments({}).session(
        session,
      );
      if (existingCount !== 0) {
        throw new Error(
          "Admin bootstrap is permitted only when no admin identity exists",
        );
      }
      await models.AdminIdentity.create(
        [
          {
            adminId,
            email: input.email,
            passwordHash,
            role: "admin",
            status: "active",
            tokenVersion: 0,
          },
        ],
        { session },
      );
      await appendAuditEntryInTransaction(
        mongo.connection,
        {
          scope: "platform",
          entityType: "AdminAction",
          entityId: adminId,
          action: "admin_bootstrapped",
          actorType: "system",
          actorId: "admin-bootstrap",
          after: { role: "admin", status: "active" },
        },
        session,
      );
    });
    process.stdout.write("Admin identity created\n");
  } finally {
    await mongo.stop();
  }
}

void main().catch(() => {
  process.stderr.write("Admin bootstrap failed\n");
  process.exitCode = 1;
});
