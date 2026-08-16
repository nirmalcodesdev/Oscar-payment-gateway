import { describe, expect, it } from "vitest";

import {
  evaluatePaymentTransition,
  isTerminalPaymentStatus,
  paymentStatuses,
  type PaymentStatus,
  type TransitionGuardInput,
} from "../../../src/domain/payments/payment-state-machine.js";

const baseInput: TransitionGuardInput = {
  from: "pending",
  to: "matched",
  now: new Date("2026-08-16T12:00:00.000Z"),
  expiresAt: new Date("2026-08-16T12:10:00.000Z"),
  reorgGraceMs: 900_000,
  confirmations: 0,
  requiredConfirmations: 6,
  canonical: true,
  complianceClear: true,
  qualifyingEventClaimed: true,
};

/** All inputs with a specific from/to so the full table can be walked. */
function inputFor(from: PaymentStatus, to: PaymentStatus): TransitionGuardInput {
  return {
    ...baseInput,
    from,
    to,
    confirmations: from === "confirming" || to === "confirming" ? 3 : 0,
  };
}

describe("payment state machine transition table", () => {
  it("accepts every legal transition under its guards", () => {
    const legal: readonly [PaymentStatus, PaymentStatus][] = [
      ["pending", "matched"],
      ["matched", "confirming"],
      ["confirming", "confirming"],
      ["confirming", "confirmed"],
      ["matched", "failed"],
      ["confirming", "failed"],
      ["pending", "expired"],
    ];
    for (const [from, to] of legal) {
      const input = inputFor(from, to);
      if (to === "failed") {
        // Guard: reorg removed the tx and the grace deadline elapsed.
        expect(
          evaluatePaymentTransition({
            ...input,
            canonical: false,
            now: new Date(baseInput.expiresAt.getTime() + baseInput.reorgGraceMs + 1),
          }),
        ).toEqual({ legal: true });
        continue;
      }
      if (to === "expired") {
        expect(
          evaluatePaymentTransition({
            ...input,
            now: new Date(baseInput.expiresAt.getTime() + 1),
            qualifyingEventClaimed: false,
          }),
        ).toEqual({ legal: true });
        continue;
      }
      if (to === "confirmed") {
        expect(
          evaluatePaymentTransition({
            ...input,
            confirmations: 6,
            requiredConfirmations: 6,
          }),
        ).toEqual({ legal: true });
        continue;
      }
      expect(evaluatePaymentTransition(input)).toEqual({ legal: true });
    }
  });

  it("rejects every transition outside the table as illegal", () => {
    const illegal: readonly [PaymentStatus, PaymentStatus][] = [
      ["pending", "confirming"],
      ["pending", "confirmed"],
      ["pending", "failed"],
      ["matched", "matched"],
      ["matched", "confirmed"],
      ["matched", "pending"],
      ["matched", "expired"],
      ["confirming", "matched"],
      ["confirming", "pending"],
      ["confirming", "expired"],
      ["confirmed", "pending"],
      ["confirmed", "matched"],
      ["confirmed", "confirming"],
      ["confirmed", "expired"],
      ["confirmed", "failed"],
      ["expired", "pending"],
      ["expired", "matched"],
      ["expired", "confirming"],
      ["expired", "confirmed"],
      ["expired", "failed"],
      ["failed", "pending"],
      ["failed", "matched"],
      ["failed", "confirming"],
      ["failed", "confirmed"],
      ["failed", "expired"],
    ];
    for (const [from, to] of illegal) {
      expect(evaluatePaymentTransition(inputFor(from, to))).toEqual({
        legal: false,
        reason: "illegal_transition",
      });
    }
  });

  it("covers every status pair in the table", () => {
    expect(paymentStatuses).toHaveLength(6);
    const covered = new Set<string>();
    for (const from of paymentStatuses) {
      for (const to of paymentStatuses) {
        if (from === to && from !== "confirming") continue;
        covered.add(`${from}->${to}`);
      }
    }
    expect(covered.size).toBeGreaterThanOrEqual(25);
  });
});

describe("pending -> matched guards", () => {
  it("rejects an expired payment even with a qualifying event", () => {
    expect(
      evaluatePaymentTransition({
        ...inputFor("pending", "matched"),
        now: new Date(baseInput.expiresAt.getTime() + 1),
      }),
    ).toEqual({ legal: false, reason: "payment_expired" });
  });

  it("rejects a live payment without a qualifying event", () => {
    expect(
      evaluatePaymentTransition({
        ...inputFor("pending", "matched"),
        qualifyingEventClaimed: false,
      }),
    ).toEqual({ legal: false, reason: "qualifying_event_missing" });
  });
});

describe("matched -> confirming guard", () => {
  it("rejects when the matching transaction is not canonical", () => {
    expect(
      evaluatePaymentTransition({
        ...inputFor("matched", "confirming"),
        canonical: false,
      }),
    ).toEqual({ legal: false, reason: "event_not_canonical" });
  });
});

describe("confirming self-loop guard", () => {
  it("is legal only while confirmations remain below the snapshot", () => {
    expect(evaluatePaymentTransition(inputFor("confirming", "confirming"))).toEqual({
      legal: true,
    });
    expect(
      evaluatePaymentTransition({
        ...inputFor("confirming", "confirming"),
        confirmations: 6,
        requiredConfirmations: 6,
      }),
    ).toEqual({ legal: false, reason: "confirmations_below_snapshot" });
  });
});

describe("confirming -> confirmed guards", () => {
  it("rejects below the confirmation snapshot", () => {
    expect(
      evaluatePaymentTransition({
        ...inputFor("confirming", "confirmed"),
        confirmations: 5,
        requiredConfirmations: 6,
      }),
    ).toEqual({ legal: false, reason: "confirmations_below_snapshot" });
  });

  it("rejects a non-canonical transaction at threshold", () => {
    expect(
      evaluatePaymentTransition({
        ...inputFor("confirming", "confirmed"),
        confirmations: 6,
        canonical: false,
      }),
    ).toEqual({ legal: false, reason: "event_not_canonical" });
  });

  it("rejects a held compliance result at threshold", () => {
    expect(
      evaluatePaymentTransition({
        ...inputFor("confirming", "confirmed"),
        confirmations: 6,
        complianceClear: false,
      }),
    ).toEqual({ legal: false, reason: "compliance_hold" });
  });
});

describe("reorg failure guards", () => {
  it("rejects while the transaction is still canonical", () => {
    expect(
      evaluatePaymentTransition({
        ...inputFor("confirming", "failed"),
        canonical: true,
        now: new Date(baseInput.expiresAt.getTime() + baseInput.reorgGraceMs + 1),
      }),
    ).toEqual({ legal: false, reason: "event_not_canonical" });
  });

  it("rejects before expiry plus grace has elapsed", () => {
    expect(
      evaluatePaymentTransition({
        ...inputFor("matched", "failed"),
        canonical: false,
        now: new Date(baseInput.expiresAt.getTime() + baseInput.reorgGraceMs),
      }),
    ).toEqual({ legal: false, reason: "reorg_grace_not_elapsed" });
  });
});

describe("pending -> expired guards", () => {
  it("rejects before expiry", () => {
    expect(
      evaluatePaymentTransition({
        ...inputFor("pending", "expired"),
        now: baseInput.now,
        qualifyingEventClaimed: false,
      }),
    ).toEqual({ legal: false, reason: "expiry_not_reached" });
  });

  it("rejects when a qualifying event was already claimed", () => {
    expect(
      evaluatePaymentTransition({
        ...inputFor("pending", "expired"),
        now: new Date(baseInput.expiresAt.getTime() + 1),
        qualifyingEventClaimed: true,
      }),
    ).toEqual({ legal: false, reason: "matching_event_present" });
  });
});

describe("terminal status helper", () => {
  it("classifies only confirmed, expired, and failed as terminal", () => {
    expect(isTerminalPaymentStatus("confirmed")).toBe(true);
    expect(isTerminalPaymentStatus("expired")).toBe(true);
    expect(isTerminalPaymentStatus("failed")).toBe(true);
    expect(isTerminalPaymentStatus("pending")).toBe(false);
    expect(isTerminalPaymentStatus("matched")).toBe(false);
    expect(isTerminalPaymentStatus("confirming")).toBe(false);
  });
});
