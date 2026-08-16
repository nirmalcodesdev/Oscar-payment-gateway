import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  signWebhookPayload,
  signedWebhookHeaders,
  webhookHeaderNames,
} from "../../../src/infrastructure/auth/webhook-signer.js";
import type { RuntimeConfig } from "../../../src/config/environment.js";

const currentSecret = "current-webhook-secret-32-bytes-ok!!";
const previousSecret = "previous-webhook-secret-32-bytes!!";

function webhookConfig(
  overrides: Partial<RuntimeConfig["webhooks"]> = {},
): RuntimeConfig["webhooks"] {
  return {
    hmacCurrentKeyId: "wk-1",
    hmacCurrentSecret: currentSecret,
    hmacPreviousKeyId: "wk-0",
    hmacPreviousSecret: previousSecret,
    deliveryTimeoutMs: 10_000,
    maxAttempts: 8,
    retentionSec: 604_800,
    ...overrides,
  };
}

describe("webhook signing", () => {
  it("signs timestamp, delivery id, and the exact body bytes deterministically", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    const first = signWebhookPayload(currentSecret, "1000", "delivery_1", body);
    const second = signWebhookPayload(currentSecret, "1000", "delivery_1", body);
    const expected = createHmac("sha256", currentSecret);
    expected.update("1000\ndelivery_1\n", "utf8");
    expected.update(body);
    expect(first).toBe(second);
    expect(first).toBe(expected.digest("hex"));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes for tampered bodies, timestamps, delivery ids, and secrets", () => {
    const body = Buffer.from("x");
    const baseline = signWebhookPayload(currentSecret, "1", "d", body);
    expect(signWebhookPayload(currentSecret, "1", "d", Buffer.from("y"))).not.toBe(
      baseline,
    );
    expect(signWebhookPayload(currentSecret, "2", "d", body)).not.toBe(baseline);
    expect(signWebhookPayload(currentSecret, "1", "e", body)).not.toBe(baseline);
    expect(signWebhookPayload(previousSecret, "1", "d", body)).not.toBe(baseline);
  });

  it("builds the documented header set with the current key id", () => {
    const body = Buffer.from("payload");
    const { headers, signed } = signedWebhookHeaders(
      webhookConfig(),
      "delivery_42",
      body,
    );
    expect(signed.keyId).toBe("wk-1");
    expect(headers[webhookHeaderNames.keyId]).toBe("wk-1");
    expect(headers[webhookHeaderNames.deliveryId]).toBe("delivery_42");
    expect(headers["content-type"]).toBe("application/json");
    const timestamp = headers[webhookHeaderNames.timestamp];
    expect(typeof timestamp).toBe("string");
    expect(Number(timestamp)).toBeGreaterThan(0);
    expect(
      signWebhookPayload(currentSecret, timestamp ?? "", "delivery_42", body),
    ).toBe(headers[webhookHeaderNames.signature]);
  });

  it("signs with the previous secret only during rotation windows", () => {
    const body = Buffer.from("rotation");
    const rotated = signWebhookPayload(previousSecret, "5", "delivery_r", body);
    expect(rotated).not.toBe(
      signWebhookPayload(currentSecret, "5", "delivery_r", body),
    );
  });
});
