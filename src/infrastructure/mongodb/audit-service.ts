import { createHash, randomUUID } from "node:crypto";

import type { ClientSession, Connection } from "mongoose";

import { registerPersistenceModels } from "./models.js";
import { withRequiredTransaction } from "./transactions.js";

const genesisHash = "0".repeat(64);
const hashVersion = 1;

type AuditActorType = "merchant" | "admin" | "system";

export interface AppendAuditEntry {
  readonly scope: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly eventId?: string;
  readonly transactionHash?: string;
  readonly metadata?: unknown;
  readonly occurredAt?: Date;
}

interface AuditHashPayload extends AppendAuditEntry {
  readonly auditId: string;
  readonly sequence: number;
  readonly occurredAt: Date;
  readonly hashVersion: number;
  readonly previousHash: string;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === 11_000
  );
}

function auditChainConflict(cause: unknown): Error & {
  hasErrorLabel(label: string): boolean;
} {
  const conflict = new Error("Audit chain changed concurrently", { cause }) as Error & {
    hasErrorLabel(label: string): boolean;
  };
  conflict.hasErrorLabel = (label) => label === "TransientTransactionError";
  return conflict;
}

function normalizeCanonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeCanonical(nested)]),
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new TypeError("Audit payload contains a non-canonical value");
}

export function canonicalAuditJson(value: unknown): string {
  return JSON.stringify(normalizeCanonical(value));
}

export function calculateAuditHash(payload: AuditHashPayload): string {
  return createHash("sha256").update(canonicalAuditJson(payload), "utf8").digest("hex");
}

export async function appendAuditEntryInTransaction(
  connection: Connection,
  input: AppendAuditEntry,
  session: ClientSession,
) {
  const models = registerPersistenceModels(connection);
  let head;
  try {
    head = await models.AuditChainHead.findOneAndUpdate(
      { scope: input.scope },
      {
        $setOnInsert: {
          scope: input.scope,
          sequence: 0,
          entryHash: genesisHash,
          version: 0,
        },
      },
      { new: true, upsert: true, session, setDefaultsOnInsert: true },
    ).lean();
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) throw auditChainConflict(error);
    throw error;
  }

  const sequence = head.sequence + 1;
  const occurredAt = input.occurredAt ?? new Date();
  const auditId = `audit_${randomUUID()}`;
  const hashPayload: AuditHashPayload = {
    ...input,
    auditId,
    sequence,
    occurredAt,
    hashVersion,
    previousHash: head.entryHash,
  };
  const entryHash = calculateAuditHash(hashPayload);

  let entry;
  try {
    entry = await new models.AuditLog({ ...hashPayload, entryHash }).save({
      session,
    });
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) throw auditChainConflict(error);
    throw error;
  }

  const advanced = await models.AuditChainHead.updateOne(
    { scope: input.scope, sequence: head.sequence, version: head.version },
    {
      $set: { sequence, entryHash },
      $inc: { version: 1 },
    },
    { session },
  );
  if (advanced.modifiedCount !== 1) {
    throw auditChainConflict(new Error("Audit chain head version changed"));
  }

  return entry.toObject();
}

export async function appendAuditEntry(
  connection: Connection,
  input: AppendAuditEntry,
) {
  return withRequiredTransaction(connection, (session) =>
    appendAuditEntryInTransaction(connection, input, session),
  );
}

export interface AuditVerificationResult {
  readonly valid: boolean;
  readonly entriesChecked: number;
  readonly reason?: string;
}

export async function verifyAuditChain(
  connection: Connection,
  scope: string,
): Promise<AuditVerificationResult> {
  const models = registerPersistenceModels(connection);
  const entries = await models.AuditLog.find({ scope }).sort({ sequence: 1 }).lean();
  let previousHash = genesisHash;
  let expectedSequence = 1;

  for (const entry of entries) {
    if (entry.sequence !== expectedSequence) {
      return {
        valid: false,
        entriesChecked: expectedSequence - 1,
        reason: "Audit sequence is not contiguous",
      };
    }
    if (entry.previousHash !== previousHash) {
      return {
        valid: false,
        entriesChecked: expectedSequence - 1,
        reason: "Audit previous hash does not match",
      };
    }

    const hashPayload: AuditHashPayload = {
      auditId: entry.auditId,
      scope: entry.scope,
      sequence: entry.sequence,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      actorType: entry.actorType as AuditActorType,
      actorId: entry.actorId,
      occurredAt: entry.occurredAt,
      hashVersion: entry.hashVersion,
      previousHash: entry.previousHash,
      ...(entry.before === undefined ? {} : { before: entry.before }),
      ...(entry.after === undefined ? {} : { after: entry.after }),
      ...(typeof entry.eventId === "string" ? { eventId: entry.eventId } : {}),
      ...(typeof entry.transactionHash === "string"
        ? { transactionHash: entry.transactionHash }
        : {}),
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    };
    const calculated = calculateAuditHash(hashPayload);
    if (calculated !== entry.entryHash) {
      return {
        valid: false,
        entriesChecked: expectedSequence - 1,
        reason: "Audit entry hash does not match its payload",
      };
    }

    previousHash = entry.entryHash;
    expectedSequence += 1;
  }

  const head = await models.AuditChainHead.findOne({ scope }).lean();
  if (entries.length === 0 && head !== null) {
    return {
      valid: false,
      entriesChecked: 0,
      reason: "Audit chain head exists without retained entries",
    };
  }
  if (
    entries.length > 0 &&
    (head === null ||
      head.sequence !== entries.length ||
      head.entryHash !== previousHash)
  ) {
    return {
      valid: false,
      entriesChecked: entries.length,
      reason: "Audit chain head does not match the retained entries",
    };
  }

  return { valid: true, entriesChecked: entries.length };
}
