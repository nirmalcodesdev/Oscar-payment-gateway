/**
 * Guarded payment state machine (ADR 0011, `prompt.md` §3.4).
 *
 * Pure transition evaluation only: no I/O, no clock reads, no storage. The
 * caller supplies every guard input; the application service executes legal
 * transitions as conditional writes and records rejected attempts as
 * auditable no-ops.
 */

export const paymentStatuses = [
  "pending",
  "matched",
  "confirming",
  "confirmed",
  "expired",
  "failed",
] as const;

export type PaymentStatus = (typeof paymentStatuses)[number];

export const terminalPaymentStatuses = ["confirmed", "expired", "failed"] as const;

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return (terminalPaymentStatuses as readonly string[]).includes(status);
}

export type TransitionRejectionReason =
  | "illegal_transition"
  | "payment_expired"
  | "qualifying_event_missing"
  | "qualifying_event_already_claimed"
  | "event_not_canonical"
  | "confirmations_below_snapshot"
  | "compliance_hold"
  | "reorg_grace_not_elapsed"
  | "expiry_not_reached"
  | "matching_event_present";

export type TransitionEvaluation =
  | { readonly legal: true }
  | { readonly legal: false; readonly reason: TransitionRejectionReason };

export interface TransitionGuardInput {
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;
  /** Evaluation time; callers pass `new Date()` at decision time. */
  readonly now: Date;
  readonly expiresAt: Date;
  /** Replacement grace added after expiry before a reorg can fail a payment. */
  readonly reorgGraceMs: number;
  /** Currently observed confirmation depth of the matching transaction. */
  readonly confirmations: number;
  /** Snapshotted depth required for confirmation. */
  readonly requiredConfirmations: number;
  /** Fresh canonicality of the matching transaction and its events. */
  readonly canonical: boolean;
  /** Fresh clear compliance result for the event sender. */
  readonly complianceClear: boolean;
  /**
   * A qualifying (cumulative) set of events is currently claimable by this
   * payment: the guard for `pending -> matched` and the inverse guard for
   * `pending -> expired`.
   */
  readonly qualifyingEventClaimed: boolean;
}

/**
 * Evaluate one transition attempt against the exact §3.4 table. Every
 * combination not listed there is illegal; illegal attempts are auditable
 * no-ops, never errors.
 */
export function evaluatePaymentTransition(
  input: TransitionGuardInput,
): TransitionEvaluation {
  const expired = input.now.getTime() > input.expiresAt.getTime();
  const reorgDeadline = input.expiresAt.getTime() + input.reorgGraceMs;

  const pendingToMatched =
    input.from === "pending" &&
    input.to === "matched" &&
    !expired &&
    input.qualifyingEventClaimed;
  if (pendingToMatched) return { legal: true };

  const matchedToConfirming =
    input.from === "matched" && input.to === "confirming" && input.canonical;
  if (matchedToConfirming) return { legal: true };

  const confirmingSelfLoop =
    input.from === "confirming" &&
    input.to === "confirming" &&
    input.confirmations < input.requiredConfirmations;
  if (confirmingSelfLoop) return { legal: true };

  const confirmingToConfirmed =
    input.from === "confirming" &&
    input.to === "confirmed" &&
    input.confirmations >= input.requiredConfirmations &&
    input.canonical &&
    input.complianceClear;
  if (confirmingToConfirmed) return { legal: true };

  const reorgFailure =
    (input.from === "matched" || input.from === "confirming") &&
    input.to === "failed" &&
    !input.canonical &&
    input.now.getTime() > reorgDeadline;
  if (reorgFailure) return { legal: true };

  const pendingToExpired =
    input.from === "pending" &&
    input.to === "expired" &&
    expired &&
    !input.qualifyingEventClaimed;
  if (pendingToExpired) return { legal: true };

  // Rejections for table edges whose guards failed, in table order.
  if (input.from === "pending" && input.to === "matched") {
    return expired
      ? { legal: false, reason: "payment_expired" }
      : { legal: false, reason: "qualifying_event_missing" };
  }
  if (input.from === "matched" && input.to === "confirming") {
    return { legal: false, reason: "event_not_canonical" };
  }
  if (input.from === "confirming" && input.to === "confirming") {
    return { legal: false, reason: "confirmations_below_snapshot" };
  }
  if (input.from === "confirming" && input.to === "confirmed") {
    if (input.confirmations < input.requiredConfirmations) {
      return { legal: false, reason: "confirmations_below_snapshot" };
    }
    if (!input.canonical) {
      return { legal: false, reason: "event_not_canonical" };
    }
    return { legal: false, reason: "compliance_hold" };
  }
  if (
    (input.from === "matched" || input.from === "confirming") &&
    input.to === "failed"
  ) {
    if (input.canonical) {
      return { legal: false, reason: "event_not_canonical" };
    }
    return { legal: false, reason: "reorg_grace_not_elapsed" };
  }
  if (input.from === "pending" && input.to === "expired") {
    return expired
      ? { legal: false, reason: "matching_event_present" }
      : { legal: false, reason: "expiry_not_reached" };
  }

  return { legal: false, reason: "illegal_transition" };
}
