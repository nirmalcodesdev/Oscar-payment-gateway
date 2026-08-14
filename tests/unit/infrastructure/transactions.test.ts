import type { Connection } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import { withRequiredTransaction } from "../../../src/infrastructure/mongodb/transactions.js";

function transactionConnection(commitTransaction: () => Promise<void>): Connection {
  const session = {
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(commitTransaction),
    abortTransaction: vi.fn().mockResolvedValue(undefined),
    inTransaction: vi.fn().mockReturnValue(false),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  return {
    db: {
      admin: () => ({
        command: vi.fn().mockResolvedValue({
          isWritablePrimary: true,
          logicalSessionTimeoutMinutes: 30,
          setName: "rs0",
        }),
      }),
    },
    startSession: vi.fn().mockResolvedValue(session),
  } as unknown as Connection;
}

describe("required MongoDB transactions", () => {
  it("retries an ambiguous commit without rerunning the transaction body", async () => {
    const ambiguousCommit = Object.assign(new Error("ambiguous commit"), {
      hasErrorLabel: (label: string) => label === "UnknownTransactionCommitResult",
    });
    let commitAttempts = 0;
    const connection = transactionConnection(() => {
      commitAttempts += 1;
      return commitAttempts === 1 ? Promise.reject(ambiguousCommit) : Promise.resolve();
    });
    const operation = vi.fn().mockResolvedValue("committed");

    await expect(withRequiredTransaction(connection, operation)).resolves.toBe(
      "committed",
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(commitAttempts).toBe(2);
  });

  it("retries an explicit MongoDB write conflict even when the label is absent", async () => {
    const connection = transactionConnection(() => Promise.resolve());
    const operation = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: 112 }))
      .mockResolvedValueOnce("committed");

    await expect(withRequiredTransaction(connection, operation)).resolves.toBe(
      "committed",
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
