import { describe, expect, it } from "vitest";

import {
  ApplicationError,
  errorCodes,
} from "../../../src/domain/errors/application-error.js";

describe("ApplicationError", () => {
  it("carries only a supported public error code", () => {
    const error = new ApplicationError("NOT_FOUND", "Not found", 404);

    expect(errorCodes).toContain(error.code);
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe("ApplicationError");
  });
});
