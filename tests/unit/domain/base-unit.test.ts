import { describe, expect, it } from "vitest";

import {
  formatBaseUnits,
  isBaseUnitString,
  isPositiveBaseUnitString,
  parseBaseUnits,
  parsePositiveBaseUnits,
} from "../../../src/domain/money/base-unit.js";

describe("base-unit money values", () => {
  it.each(["0", "1", "999999999999999999999999999999999999999999"])(
    "accepts canonical non-negative integer %s",
    (value) => {
      expect(isBaseUnitString(value)).toBe(true);
      expect(formatBaseUnits(parseBaseUnits(value))).toBe(value);
    },
  );

  it.each(["", "00", "01", "-1", "+1", "1.0", "1e3", " 1", 1, null])(
    "rejects non-canonical amount %j",
    (value) => {
      expect(isBaseUnitString(value)).toBe(false);
    },
  );

  it("requires strictly positive values where a payment amount is expected", () => {
    expect(isPositiveBaseUnitString("0")).toBe(false);
    expect(parsePositiveBaseUnits("42")).toBe(42n);
    expect(() => parsePositiveBaseUnits("0")).toThrow(TypeError);
    expect(() => parseBaseUnits("1.5")).toThrow(TypeError);
  });

  it("never formats negative bigint values", () => {
    expect(() => formatBaseUnits(-1n)).toThrow(RangeError);
  });
});
