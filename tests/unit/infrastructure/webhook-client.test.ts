import pino from "pino";
import { describe, expect, it } from "vitest";

import {
  isBlockedAddress,
  WebhookDeliveryClient,
  WebhookDeliveryError,
} from "../../../src/infrastructure/http/webhook-client.js";
import type { RuntimeConfig } from "../../../src/config/environment.js";

const logger = pino({ level: "silent" });

function webhookConfig(
  overrides: Partial<RuntimeConfig["webhooks"]> = {},
): RuntimeConfig["webhooks"] {
  return {
    hmacCurrentKeyId: "wk-1",
    hmacCurrentSecret: "test-webhook-secret-32-bytes-ok!!",
    deliveryTimeoutMs: 500,
    maxAttempts: 2,
    retentionSec: 604_800,
    ...overrides,
  };
}

describe("webhook address blocklist", () => {
  it("blocks loopback, private, metadata, CGNAT, and reserved ranges", () => {
    for (const blocked of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456:789a::1",
      "::ffff:127.0.0.1",
      "not-an-ip",
    ]) {
      expect(isBlockedAddress(blocked), blocked).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const allowed of ["1.1.1.1", "8.8.8.8", "203.0.113.10", "2606:4700::1111"]) {
      expect(isBlockedAddress(allowed), allowed).toBe(false);
    }
  });
});

describe("WebhookDeliveryClient URL validation", () => {
  it("rejects non-HTTPS destinations in production", async () => {
    const client = new WebhookDeliveryClient(webhookConfig(), "production", logger);
    await expect(
      client.deliver("http://example.com", Buffer.from("x"), {}),
    ).rejects.toMatchObject({ failure: "invalid_url" });
  });

  it("rejects credentials in the URL", async () => {
    const client = new WebhookDeliveryClient(webhookConfig(), "test", logger);
    await expect(
      client.deliver("http://user:pass@127.0.0.1:9/x", Buffer.from("x"), {}),
    ).rejects.toMatchObject({ failure: "invalid_url" });
  });

  it("blocks loopback destinations that are not test-allowlisted", async () => {
    const client = new WebhookDeliveryClient(webhookConfig(), "test", logger);
    await expect(
      client.deliver("http://127.0.0.1:9/hook", Buffer.from("x"), {}),
    ).rejects.toMatchObject({ failure: "blocked_address" });
  });

  it("blocks hostnames that resolve to private addresses", async () => {
    const client = new WebhookDeliveryClient(webhookConfig(), "test", logger);
    await expect(
      client.deliver("http://localhost:9/hook", Buffer.from("x"), {}),
    ).rejects.toMatchObject({ failure: "blocked_address" });
  });

  it("blocks cloud metadata endpoints directly", async () => {
    const client = new WebhookDeliveryClient(webhookConfig(), "test", logger);
    await expect(
      client.deliver("http://169.254.169.254/latest/meta-data", Buffer.from("x"), {}),
    ).rejects.toMatchObject({ failure: "blocked_address" });
  });

  it("reports dns failure for unresolvable hostnames", async () => {
    const client = new WebhookDeliveryClient(webhookConfig(), "test", logger);
    await expect(
      client.deliver(
        "http://definitely-not-a-real-hostname-oscar.invalid/hook",
        Buffer.from("x"),
        {},
      ),
    ).rejects.toMatchObject({ failure: "dns_failure" });
  });

  it("times out against unresponsive destinations", async () => {
    const client = new WebhookDeliveryClient(
      webhookConfig({ deliveryTimeoutMs: 300 }),
      "test",
      logger,
      { allowedTestDestinations: ["127.0.0.1:9"] },
    );
    // Port 9 (discard) is not listening in CI: the connection either refuses
    // or times out; both are hard failures, never successes.
    await expect(
      client.deliver("http://127.0.0.1:9/hook", Buffer.from("x"), {}),
    ).rejects.toBeInstanceOf(WebhookDeliveryError);
  });

  it("refuses test allowlists in production", () => {
    expect(
      () =>
        new WebhookDeliveryClient(webhookConfig(), "production", logger, {
          allowedTestDestinations: ["127.0.0.1:9"],
        }),
    ).toThrow();
  });
});
