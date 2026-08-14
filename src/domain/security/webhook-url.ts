import { isIP } from "node:net";

export function validateWebhookUrl(
  value: string,
  nodeEnv: "development" | "test" | "production",
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Webhook URL is invalid");
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new Error("Webhook URL credentials and fragments are forbidden");
  }
  if (parsed.hostname.length === 0 || parsed.href.length > 2048) {
    throw new Error("Webhook URL is invalid");
  }
  if (nodeEnv === "production") {
    if (parsed.protocol !== "https:") {
      throw new Error("Production webhook URLs must use HTTPS");
    }
    if (parsed.port !== "" && parsed.port !== "443") {
      throw new Error("Production webhook URL port is forbidden");
    }
    if (isIP(parsed.hostname) !== 0 || parsed.hostname === "localhost") {
      throw new Error("Production webhook URLs must use a public DNS name");
    }
  } else if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Webhook URL protocol is forbidden");
  }
  return parsed.toString();
}
