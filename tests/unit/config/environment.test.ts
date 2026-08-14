import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../../../src/config/environment.js";
import { validEnvironment } from "../../helpers/environment.js";

describe("loadConfig", () => {
  it("loads and freezes a valid replica-set configuration", () => {
    const config = loadConfig(validEnvironment());

    expect(config.mongodb.replicaSet).toBe("rs0");
    expect(config.redis.queuePrefix).toBe("oscar-test");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.mongodb)).toBe(true);
  });

  it("rejects missing required values without echoing secret values", () => {
    const environment = validEnvironment({ REDIS_URL: undefined });

    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
    try {
      loadConfig(environment);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues.join(" ")).not.toContain(
        "mongodb://127.0.0.1",
      );
    }
  });

  it("rejects MongoDB without an explicit matching replica set", () => {
    try {
      loadConfig(
        validEnvironment({
          MONGODB_URI: "mongodb://127.0.0.1:27017/oscar_test",
        }),
      );
      throw new Error("Expected configuration validation to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues).toContain(
        "MONGODB_URI replicaSet must match MONGODB_REPLICA_SET",
      );
    }
  });

  it("rejects unsupported Redis protocols", () => {
    try {
      loadConfig(validEnvironment({ REDIS_URL: "https://redis.example" }));
      throw new Error("Expected configuration validation to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues).toContain(
        "REDIS_URL must use redis or rediss",
      );
    }
  });

  it("rejects out-of-range numeric configuration", () => {
    expect(() => loadConfig(validEnvironment({ API_PORT: "70000" }))).toThrow(
      ConfigurationError,
    );
  });

  it("rejects malformed and unsupported MongoDB URIs", () => {
    for (const uri of [
      "not a URI",
      "https://mongodb.example/database?replicaSet=rs0",
    ]) {
      expect(() => loadConfig(validEnvironment({ MONGODB_URI: uri }))).toThrow(
        ConfigurationError,
      );
    }
  });

  it("requires previous admin JWT key material as a complete pair", () => {
    expect(() =>
      loadConfig(
        validEnvironment({
          ADMIN_JWT_PREVIOUS_KEY_ID: "previous-v1",
          ADMIN_JWT_PREVIOUS_SECRET: "",
        }),
      ),
    ).toThrow(ConfigurationError);
  });

  it("rejects weak auth secrets and malformed wallet network policy", () => {
    expect(() =>
      loadConfig(validEnvironment({ ADMIN_JWT_CURRENT_SECRET: "too-short" })),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig(validEnvironment({ WALLET_NETWORK_ALLOWLIST: "[]" })),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig(
        validEnvironment({
          WALLET_NETWORK_ALLOWLIST: '{"ethereum-sepolia":"unsupported"}',
        }),
      ),
    ).toThrow(ConfigurationError);
  });
});
