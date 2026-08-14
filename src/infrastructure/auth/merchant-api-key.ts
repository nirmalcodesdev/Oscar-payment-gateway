import { randomBytes } from "node:crypto";

const keyPattern = /^osk_(live|test)_([a-f0-9]{18})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedMerchantApiKey {
  readonly key: string;
  readonly prefix: string;
}

export interface ParsedMerchantApiKey {
  readonly key: string;
  readonly prefix: string;
}

export function generateMerchantApiKey(
  nodeEnv: "development" | "test" | "production",
): GeneratedMerchantApiKey {
  const mode = nodeEnv === "production" ? "live" : "test";
  const prefix = `osk_${mode}_${randomBytes(9).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  return { key: `${prefix}_${secret}`, prefix };
}

export function parseMerchantApiKey(value: unknown): ParsedMerchantApiKey | undefined {
  if (typeof value !== "string") return undefined;
  const match = keyPattern.exec(value);
  if (match === null) return undefined;
  return { key: value, prefix: `osk_${match[1]}_${match[2]}` };
}
