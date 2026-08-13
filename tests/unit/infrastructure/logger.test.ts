import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/environment.js";
import { createLogger } from "../../../src/infrastructure/logging/logger.js";
import { validEnvironment } from "../../helpers/environment.js";

describe("createLogger", () => {
  it("binds safe service and process metadata", () => {
    const logger = createLogger(loadConfig(validEnvironment()), "processor");

    expect(logger.bindings()).toMatchObject({
      service: "oscar-payment-gateway-test",
      process: "processor",
      environment: "test",
    });
    expect(logger.level).toBe("error");
  });

  it("redacts merchant credentials from serialized request data", () => {
    let output = "";
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString("utf8");
        callback();
      },
    });
    const logger = createLogger(
      loadConfig(validEnvironment({ LOG_LEVEL: "info" })),
      "api",
      destination,
    );

    logger.info({ req: { headers: { "x-oscar-merchant-api-key": "secret-key" } } });

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("secret-key");
  });
});
