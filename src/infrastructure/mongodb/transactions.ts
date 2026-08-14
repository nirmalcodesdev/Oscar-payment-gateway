import type { ClientSession, Connection } from "mongoose";

const maximumTransactionAttempts = 5;

export class TransactionCapabilityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TransactionCapabilityError";
  }
}

interface HelloResponse {
  readonly isWritablePrimary?: unknown;
  readonly logicalSessionTimeoutMinutes?: unknown;
  readonly msg?: unknown;
  readonly setName?: unknown;
}

function hasErrorLabel(error: unknown, label: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { hasErrorLabel?: unknown };
  return (
    typeof candidate.hasErrorLabel === "function" &&
    (candidate.hasErrorLabel as (value: string) => boolean)(label)
  );
}

function isRetryableTransactionError(error: unknown): boolean {
  return hasErrorLabel(error, "TransientTransactionError");
}

async function commitWithRetry(session: ClientSession): Promise<void> {
  for (let attempt = 1; attempt <= maximumTransactionAttempts; attempt += 1) {
    try {
      await session.commitTransaction();
      return;
    } catch (error: unknown) {
      if (
        !hasErrorLabel(error, "UnknownTransactionCommitResult") ||
        attempt === maximumTransactionAttempts
      ) {
        throw error;
      }
    }
  }
}

export async function assertTransactionCapability(
  connection: Connection,
): Promise<void> {
  if (connection.db === undefined) {
    throw new TransactionCapabilityError("MongoDB connection is not ready");
  }

  const hello = (await connection.db.admin().command({ hello: 1 })) as HelloResponse;
  const supportsTransactions =
    typeof hello.logicalSessionTimeoutMinutes === "number" &&
    (typeof hello.setName === "string" || hello.msg === "isdbgrid") &&
    hello.isWritablePrimary === true;

  if (!supportsTransactions) {
    throw new TransactionCapabilityError(
      "Correctness-critical writes require a writable replica set or sharded cluster",
    );
  }
}

export async function withRequiredTransaction<T>(
  connection: Connection,
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  await assertTransactionCapability(connection);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maximumTransactionAttempts; attempt += 1) {
    const session = await connection.startSession();
    try {
      session.startTransaction({
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      });
      const result = await operation(session);
      await commitWithRetry(session);
      return result;
    } catch (error: unknown) {
      lastError = error;
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      if (
        !isRetryableTransactionError(error) ||
        attempt === maximumTransactionAttempts
      ) {
        throw error;
      }
    } finally {
      await session.endSession();
    }
  }

  throw lastError;
}
