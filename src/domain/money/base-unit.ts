const canonicalBaseUnitPattern = /^(0|[1-9][0-9]*)$/;
const positiveBaseUnitPattern = /^[1-9][0-9]*$/;

export function isBaseUnitString(value: unknown): value is string {
  return typeof value === "string" && canonicalBaseUnitPattern.test(value);
}

export function isPositiveBaseUnitString(value: unknown): value is string {
  return typeof value === "string" && positiveBaseUnitPattern.test(value);
}

export function parseBaseUnits(value: string): bigint {
  if (!isBaseUnitString(value)) {
    throw new TypeError("Amount must be a canonical base-unit integer string");
  }
  return BigInt(value);
}

export function parsePositiveBaseUnits(value: string): bigint {
  if (!isPositiveBaseUnitString(value)) {
    throw new TypeError("Amount must be a positive base-unit integer string");
  }
  return BigInt(value);
}

export function formatBaseUnits(value: bigint): string {
  if (value < 0n) {
    throw new RangeError("Base-unit amount cannot be negative");
  }
  return value.toString(10);
}
