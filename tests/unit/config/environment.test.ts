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
    expect(Object.isFrozen(config.rpc.providers)).toBe(true);
    expect(config.rpc.providers["rpc-test-a"]?.operatorId).toBe("operator-a");
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

  it("rejects unsafe or non-independent RPC provider catalogs", () => {
    expect(() =>
      loadConfig(
        validEnvironment({
          RPC_PROVIDER_CATALOG:
            '{"rpc-a":{"operatorId":"same-operator","url":"http://127.0.0.1:1"},"rpc-b":{"operatorId":"same-operator","url":"http://127.0.0.1:2"}}',
        }),
      ),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig(
        validEnvironment({
          NODE_ENV: "production",
          RPC_PROVIDER_CATALOG:
            '{"rpc-a":{"operatorId":"operator-a","url":"http://rpc-a.example"},"rpc-b":{"operatorId":"operator-b","url":"https://rpc-b.example"}}',
        }),
      ),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig(
        validEnvironment({
          RPC_PROVIDER_CATALOG:
            '{"rpc-a":{"operatorId":"operator-a","url":"http://user:password@rpc-a.example"},"rpc-b":{"operatorId":"operator-b","url":"https://rpc-b.example"}}',
        }),
      ),
    ).toThrow(ConfigurationError);
  });

  it("loads payment and compliance configuration", () => {
    const config = loadConfig(validEnvironment());

    expect(config.payments.expiryMinSec).toBe(300);
    expect(config.payments.expiryMaxSec).toBe(7200);
    expect(config.payments.expiryDefaultSec).toBe(900);
    expect(config.payments.idempotencyTtlSec).toBe(86400);
    expect(config.payments.createRateLimitPerMinute).toBe(30);
    expect(config.compliance.sanctionsStaticList.listVersion).toBe("test-v1");
    expect(config.compliance.sanctionsStaticList.addresses).toEqual([
      "0xd78523784b3a8e5c21d026ee7fe405c39d1542ac",
    ]);
    expect(config.compliance.screeningCacheTtlSec).toBe(604800);
    expect(Object.isFrozen(config.payments)).toBe(true);
    expect(Object.isFrozen(config.compliance.sanctionsStaticList)).toBe(true);
  });

  it("rejects inconsistent payment expiry configuration", () => {
    expect(() =>
      loadConfig(
        validEnvironment({
          PAYMENT_EXPIRY_MIN_SEC: "7200",
          PAYMENT_EXPIRY_MAX_SEC: "300",
        }),
      ),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig(
        validEnvironment({
          PAYMENT_EXPIRY_MIN_SEC: "300",
          PAYMENT_EXPIRY_MAX_SEC: "7200",
          PAYMENT_EXPIRY_DEFAULT_SEC: "60",
        }),
      ),
    ).toThrow(ConfigurationError);
  });

  it("requires an explicit sanctions static list", () => {
    expect(() =>
      loadConfig(validEnvironment({ SANCTIONS_STATIC_LIST: undefined })),
    ).toThrow(ConfigurationError);
  });

  it("rejects malformed sanctions static lists", () => {
    for (const list of [
      "not-json",
      "[]",
      '{"listVersion":"v1"}',
      '{"listVersion":"v1","addresses":"0x1111111111111111111111111111111111111111"}',
      '{"listVersion":"","addresses":[]}',
      '{"listVersion":"v1","addresses":["not-an-address"]}',
      '{"listVersion":"v1","addresses":[],"extra":true}',
    ]) {
      expect(() =>
        loadConfig(validEnvironment({ SANCTIONS_STATIC_LIST: list })),
      ).toThrow(ConfigurationError);
    }
  });

  it("normalizes and de-duplicates sanctions addresses", () => {
    const config = loadConfig(
      validEnvironment({
        SANCTIONS_STATIC_LIST:
          '{"listVersion":"v2","addresses":["0xAbCdEf0123456789abcdef0123456789ABCDEF01","0xabcdef0123456789abcdef0123456789abcdef01"]}',
      }),
    );
    expect(config.compliance.sanctionsStaticList.addresses).toEqual([
      "0xabcdef0123456789abcdef0123456789abcdef01",
    ]);
  });
});
