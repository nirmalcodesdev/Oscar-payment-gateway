export type ScreeningVerdict =
  | "clear"
  | "flagged"
  | "blocked"
  | "unavailable"
  | "indeterminate";

export type ScreeningRiskLevel =
  | "clear"
  | "low"
  | "medium"
  | "high"
  | "blocked"
  | "unknown";

export interface ScreeningRequest {
  readonly address: string;
  readonly chain: string;
}

export interface ScreeningResult {
  readonly verdict: ScreeningVerdict;
  readonly riskLevel: ScreeningRiskLevel;
  readonly sanctioned: boolean;
  readonly provider: string;
  readonly providerVersion?: string;
  readonly listVersion?: string;
  readonly rawResponse: Readonly<Record<string, unknown>>;
}

export interface SanctionsScreeningProvider {
  screen(request: ScreeningRequest): Promise<ScreeningResult>;
}

export type PaymentScreeningStatus = "clear" | "flagged" | "blocked" | "pending";

export function screeningStatusForVerdict(
  verdict: ScreeningVerdict,
): PaymentScreeningStatus {
  switch (verdict) {
    case "clear":
      return "clear";
    case "flagged":
      return "flagged";
    case "blocked":
      return "blocked";
    case "unavailable":
    case "indeterminate":
      return "pending";
  }
}
