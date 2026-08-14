import { describe, expect, it } from "vitest";

import {
  calculateAuditHash,
  canonicalAuditJson,
} from "../../../src/infrastructure/mongodb/audit-service.js";

describe("audit integrity encoding", () => {
  it("canonicalizes object keys, nested values, dates, and absent fields", () => {
    const date = new Date("2026-08-14T00:00:00.000Z");
    expect(
      canonicalAuditJson({ z: 1, a: { y: date, x: true }, omitted: undefined }),
    ).toBe('{"a":{"x":true,"y":"2026-08-14T00:00:00.000Z"},"z":1}');
  });

  it("produces the same hash for semantically identical key order", () => {
    const common = {
      auditId: "audit_001",
      scope: "platform",
      sequence: 1,
      entityType: "Chain",
      entityId: "ethereum-mainnet",
      action: "created",
      actorType: "admin" as const,
      actorId: "admin_001",
      occurredAt: new Date("2026-08-14T00:00:00.000Z"),
      hashVersion: 1,
      previousHash: "0".repeat(64),
    };
    expect(calculateAuditHash({ ...common, after: { b: 2, a: 1 } })).toBe(
      calculateAuditHash({ ...common, after: { a: 1, b: 2 } }),
    );
  });

  it("rejects values without a deterministic JSON representation", () => {
    expect(() => canonicalAuditJson({ invalid: 1n })).toThrow(TypeError);
  });
});
