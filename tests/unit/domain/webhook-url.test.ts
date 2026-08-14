import { describe, expect, it } from "vitest";

import { validateWebhookUrl } from "../../../src/domain/security/webhook-url.js";

describe("webhook URL policy", () => {
  it("normalizes valid production HTTPS destinations", () => {
    expect(validateWebhookUrl("https://hooks.example.com/payments", "production")).toBe(
      "https://hooks.example.com/payments",
    );
  });

  it.each([
    "http://hooks.example.com/payments",
    "https://user:password@hooks.example.com/payments",
    "https://hooks.example.com:8443/payments",
    "https://127.0.0.1/payments",
    "https://localhost/payments",
    "https://hooks.example.com/payments#fragment",
  ])("rejects unsafe production destinations", (url) => {
    expect(() => validateWebhookUrl(url, "production")).toThrow();
  });

  it("permits HTTP only for non-production local development", () => {
    expect(validateWebhookUrl("http://localhost:8080/hook", "test")).toBe(
      "http://localhost:8080/hook",
    );
  });
});
