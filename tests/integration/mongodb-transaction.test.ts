import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationUri = process.env["MONGODB_INTEGRATION_URI"];
const describeWithMongo = integrationUri === undefined ? describe.skip : describe;

describeWithMongo("MongoDB replica-set transactions", () => {
  beforeAll(async () => {
    if (integrationUri === undefined) {
      throw new Error("MONGODB_INTEGRATION_URI is required for integration tests");
    }
    await mongoose.connect(integrationUri, {
      serverSelectionTimeoutMS: 10_000,
      autoIndex: false,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it("commits and rolls back multi-document transactions", async () => {
    const collection = mongoose.connection.collection("phase01_transactions");
    await collection.deleteMany({});

    const committedSession = await mongoose.startSession();
    try {
      await committedSession.withTransaction(async () => {
        await collection.insertOne(
          { marker: "committed" },
          { session: committedSession },
        );
      });
    } finally {
      await committedSession.endSession();
    }

    const rolledBackSession = await mongoose.startSession();
    try {
      await expect(
        rolledBackSession.withTransaction(async () => {
          await collection.insertOne(
            { marker: "rolled-back" },
            { session: rolledBackSession },
          );
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
    } finally {
      await rolledBackSession.endSession();
    }

    await expect(collection.countDocuments({ marker: "committed" })).resolves.toBe(1);
    await expect(collection.countDocuments({ marker: "rolled-back" })).resolves.toBe(0);
  });
});
