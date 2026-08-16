import { createHmac } from "node:crypto";

import type { RuntimeConfig } from "../../config/environment.js";

export const webhookHeaderNames = {
  keyId: "x-oscar-webhook-key-id",
  timestamp: "x-oscar-webhook-timestamp",
  deliveryId: "x-oscar-delivery-id",
  signature: "x-oscar-webhook-signature",
} as const;

export interface SignedWebhookRequest {
  readonly keyId: string;
  readonly timestamp: string;
  readonly deliveryId: string;
  readonly signature: string;
}

/**
 * Sign an outbound merchant webhook (ADR 0014): HMAC-SHA256 over
 * `${timestamp}\n${deliveryId}\n` plus the exact serialized body bytes with
 * the platform's versioned current secret. Receivers verify with the
 * constant-time comparison of their choice; senders never verify in-band.
 */
export function signWebhookPayload(
  secret: string,
  timestamp: string,
  deliveryId: string,
  body: Buffer,
): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}\n${deliveryId}\n`, "utf8");
  mac.update(body);
  return mac.digest("hex");
}

export function signedWebhookHeaders(
  config: RuntimeConfig["webhooks"],
  deliveryId: string,
  body: Buffer,
): { readonly headers: Record<string, string>; readonly signed: SignedWebhookRequest } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signWebhookPayload(
    config.hmacCurrentSecret,
    timestamp,
    deliveryId,
    body,
  );
  const signed: SignedWebhookRequest = {
    keyId: config.hmacCurrentKeyId,
    timestamp,
    deliveryId,
    signature,
  };
  return {
    headers: {
      "content-type": "application/json",
      [webhookHeaderNames.keyId]: signed.keyId,
      [webhookHeaderNames.timestamp]: signed.timestamp,
      [webhookHeaderNames.deliveryId]: signed.deliveryId,
      [webhookHeaderNames.signature]: signed.signature,
    },
    signed,
  };
}
