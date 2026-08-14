export const errorCodes = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "NOT_FOUND",
  "INTERNAL_ERROR",
  "CHAIN_ERROR",
  "COMPLIANCE_HOLD",
  "RATE_LIMITED",
  "IDEMPOTENCY_CONFLICT",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export class ApplicationError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}
