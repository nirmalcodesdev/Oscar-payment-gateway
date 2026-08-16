import { lookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../../config/environment.js";

export type WebhookDeliveryFailure =
  | "invalid_url"
  | "blocked_address"
  | "dns_failure"
  | "redirect"
  | "timeout"
  | "response_too_large"
  | "network_error"
  | "http_error";

export interface WebhookDeliveryHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly failure?: WebhookDeliveryFailure;
}

export class WebhookDeliveryError extends Error {
  public constructor(
    public readonly failure: WebhookDeliveryFailure,
    public readonly statusCode?: number,
  ) {
    super(`Webhook delivery failed: ${failure}`);
    this.name = "WebhookDeliveryError";
  }
}

const maximumResponseBytes = 64 * 1024;

function isBlockedIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  const [a, b] = octets;
  if (a === undefined || b === undefined) return true;
  // Loopback, private, link-local (incl. cloud metadata), CGNAT, reserved,
  // multicast, broadcast, and benchmark ranges are all blocked.
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // Loopback, unspecified, unique-local fc00::/7, link-local fe80::/10,
  // multicast ff00::/8, and IPv4-mapped addresses are blocked.
  if (normalized === "::1" || normalized === "::") return true;
  const head = normalized.split(":")[0] ?? "";
  const group = Number.parseInt(head, 16);
  if (!Number.isNaN(group)) {
    if (group >= 0xff00) return true; // multicast ff00::/8
    if (group >= 0xfc00 && group <= 0xfdff) return true; // unique-local fc00::/7
    if (group >= 0xfe80 && group <= 0xfebf) return true; // link-local fe80::/10
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return isBlockedIpv4(mapped);
  }
  return false;
}

/** Public-only address check for SSRF protection (ADR 0014). */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

/**
 * SSRF-hardened webhook POST (ADR 0014). DNS is resolved manually and every
 * resolved address must be public; the connection is dialed to a validated
 * IP while preserving the original hostname as Host and TLS SNI, so DNS
 * rebinding cannot redirect the actual connection to a blocked address.
 * Redirects are never followed, the request is time-bounded, and the
 * response body read is size-capped.
 */
export class WebhookDeliveryClient {
  readonly #config: RuntimeConfig["webhooks"];
  readonly #nodeEnv: "development" | "test" | "production";
  readonly #logger: Logger;
  readonly #allowedTestDestinations: ReadonlySet<string>;

  public constructor(
    config: RuntimeConfig["webhooks"],
    nodeEnv: "development" | "test" | "production",
    logger: Logger,
    options: { readonly allowedTestDestinations?: readonly string[] } = {},
  ) {
    this.#config = config;
    this.#nodeEnv = nodeEnv;
    this.#logger = logger.child({ component: "webhook-client" });
    if (options.allowedTestDestinations !== undefined && nodeEnv === "production") {
      throw new Error("Test destination allowlists are forbidden in production");
    }
    this.#allowedTestDestinations = new Set(options.allowedTestDestinations ?? []);
  }

  public async deliver(
    url: string,
    body: Buffer,
    headers: Readonly<Record<string, string>>,
  ): Promise<WebhookDeliveryHttpResponse> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new WebhookDeliveryError("invalid_url");
    }
    const httpsRequired = this.#nodeEnv === "production";
    if (
      httpsRequired
        ? parsed.protocol !== "https:"
        : parsed.protocol !== "https:" && parsed.protocol !== "http:"
    ) {
      throw new WebhookDeliveryError("invalid_url");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new WebhookDeliveryError("invalid_url");
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const testAllowlisted =
      this.#nodeEnv !== "production" &&
      this.#allowedTestDestinations.has(
        `${hostname}${parsed.port === "" ? "" : `:${parsed.port}`}`,
      );

    let addresses: string[];
    if (isIP(hostname) !== 0) {
      addresses = [hostname];
    } else {
      try {
        const resolved = await lookup(hostname, { all: true, verbatim: true });
        addresses = resolved.map((entry) => entry.address);
      } catch {
        throw new WebhookDeliveryError("dns_failure");
      }
    }
    if (addresses.length === 0) throw new WebhookDeliveryError("dns_failure");
    const blocked = addresses.filter((address) => isBlockedAddress(address));
    if (blocked.length > 0 && !testAllowlisted) {
      this.#logger.warn(
        { url: safeUrlForLog(parsed) },
        "Webhook destination resolves to a blocked address",
      );
      throw new WebhookDeliveryError("blocked_address");
    }
    const target = addresses[0] ?? "";

    const port =
      parsed.port === ""
        ? parsed.protocol === "https:"
          ? 443
          : 80
        : Number(parsed.port);
    return this.#request(parsed, target, port, body, headers);
  }

  #request(
    parsed: URL,
    targetIp: string,
    port: number,
    body: Buffer,
    headers: Readonly<Record<string, string>>,
  ): Promise<WebhookDeliveryHttpResponse> {
    return new Promise<WebhookDeliveryHttpResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, status?: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error instanceof WebhookDeliveryError) {
          reject(error);
          return;
        }
        if (status !== undefined && status > 0) {
          const ok = status >= 200 && status <= 299;
          if (ok) {
            resolve({ status, ok });
          } else if (status >= 300 && status <= 399) {
            resolve({ status, ok, failure: "redirect" });
          } else {
            resolve({ status, ok, failure: "http_error" });
          }
          return;
        }
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        reject(
          new WebhookDeliveryError(
            code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ECONNRESET"
              ? "timeout"
              : "network_error",
          ),
        );
      };

      const timeout = setTimeout(() => {
        finish(new WebhookDeliveryError("timeout"));
        outgoing.destroy();
      }, this.#config.deliveryTimeoutMs);

      const isTls = parsed.protocol === "https:";
      const send = isTls ? httpsRequest : httpRequest;
      const outgoing: ClientRequest = send(
        {
          host: targetIp,
          port,
          method: "POST",
          // Host and TLS SNI keep the original hostname; only the dialed
          // IP is pinned to the validated address.
          servername: isTls ? parsed.hostname : undefined,
          headers: { ...headers, host: parsed.host },
          setHost: false,
        },
        (response) => {
          let read = 0;
          response.on("data", (chunk: Buffer) => {
            read += chunk.length;
            if (read > maximumResponseBytes) {
              finish(new WebhookDeliveryError("response_too_large"));
              response.destroy();
            }
          });
          response.on("end", () => finish(undefined, response.statusCode ?? 0));
          response.on("error", (error: Error) => finish(error));
        },
      );
      outgoing.on("error", (error: Error) => finish(error));
      outgoing.end(body);
    });
  }
}

function safeUrlForLog(parsed: URL): string {
  return `${parsed.protocol}//${parsed.hostname}/…`;
}
