import { z } from "zod";

export const processNames = ["api", "watcher", "processor", "scheduler"] as const;
export type ProcessName = (typeof processNames)[number];

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

const integerFromEnvironment = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const secretFromEnvironment = z.string().trim().min(32).max(4096);

const optionalSecretFromEnvironment = z
  .string()
  .trim()
  .max(4096)
  .optional()
  .or(z.literal(""));

const rpcProviderCatalog = z
  .string()
  .trim()
  .min(2)
  .max(65_536)
  .transform((value, context) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: "custom", message: "must be valid JSON" });
      return z.NEVER;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      context.addIssue({ code: "custom", message: "must be a JSON object" });
      return z.NEVER;
    }
    const result: Record<string, { operatorId: string; url: string }> = {};
    for (const [providerId, rawEntry] of Object.entries(parsed)) {
      if (
        !identifierPattern.test(providerId) ||
        typeof rawEntry !== "object" ||
        rawEntry === null ||
        Array.isArray(rawEntry)
      ) {
        context.addIssue({ code: "custom", message: "contains an invalid provider" });
        return z.NEVER;
      }
      const entry = rawEntry as Record<string, unknown>;
      if (
        Object.keys(entry).some((key) => key !== "operatorId" && key !== "url") ||
        typeof entry["operatorId"] !== "string" ||
        !identifierPattern.test(entry["operatorId"]) ||
        typeof entry["url"] !== "string" ||
        entry["url"].length < 1 ||
        entry["url"].length > 2048
      ) {
        context.addIssue({ code: "custom", message: "contains invalid provider data" });
        return z.NEVER;
      }
      result[providerId] = {
        operatorId: entry["operatorId"],
        url: entry["url"],
      };
    }
    if (Object.keys(result).length < 2) {
      context.addIssue({ code: "custom", message: "requires at least two providers" });
      return z.NEVER;
    }
    return result;
  });

const walletNetworkAllowlist = z
  .string()
  .trim()
  .min(2)
  .max(16_384)
  .transform((value, context) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: "custom", message: "must be valid JSON" });
      return z.NEVER;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      context.addIssue({ code: "custom", message: "must be a JSON object" });
      return z.NEVER;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const result: Record<string, "mainnet" | "testnet"> = {};
    for (const [chainId, network] of entries) {
      if (!identifierPattern.test(chainId)) {
        context.addIssue({ code: "custom", message: "contains an invalid chain id" });
        return z.NEVER;
      }
      if (network !== "mainnet" && network !== "testnet") {
        context.addIssue({
          code: "custom",
          message: "values must be mainnet or testnet",
        });
        return z.NEVER;
      }
      result[chainId] = network;
    }
    return result;
  });

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
    SERVICE_NAME: z.string().trim().min(1).max(100),
    API_HOST: z.string().trim().min(1).max(255),
    API_PORT: integerFromEnvironment(1, 65_535),
    SHUTDOWN_TIMEOUT_MS: integerFromEnvironment(1_000, 120_000),
    MONGODB_URI: z.string().trim().min(1),
    MONGODB_REPLICA_SET: z.string().trim().min(1).max(128),
    MONGODB_CONNECT_TIMEOUT_MS: integerFromEnvironment(1_000, 120_000),
    REDIS_URL: z.url(),
    REDIS_CONNECT_TIMEOUT_MS: integerFromEnvironment(1_000, 120_000),
    QUEUE_PREFIX: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/),
    ADMIN_JWT_CURRENT_KEY_ID: z.string().trim().min(1).max(128),
    ADMIN_JWT_CURRENT_SECRET: secretFromEnvironment,
    ADMIN_JWT_PREVIOUS_KEY_ID: z.string().trim().max(128).optional().or(z.literal("")),
    ADMIN_JWT_PREVIOUS_SECRET: optionalSecretFromEnvironment,
    MERCHANT_STEP_UP_SECRET: secretFromEnvironment,
    ADMIN_ACCESS_TTL_SEC: integerFromEnvironment(60, 900).default(600),
    ADMIN_REFRESH_TTL_SEC: integerFromEnvironment(900, 2_592_000).default(604_800),
    MERCHANT_STEP_UP_TTL_SEC: integerFromEnvironment(60, 900).default(300),
    WALLET_NETWORK_ALLOWLIST: walletNetworkAllowlist,
    RPC_PROVIDER_CATALOG: rpcProviderCatalog,
    RPC_REQUEST_TIMEOUT_MS: integerFromEnvironment(500, 30_000).default(5_000),
  })
  .strict();

const environmentKeys = Object.keys(environmentSchema.shape) as (keyof z.input<
  typeof environmentSchema
>)[];

export interface RuntimeConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  readonly serviceName: string;
  readonly api: {
    readonly host: string;
    readonly port: number;
  };
  readonly shutdownTimeoutMs: number;
  readonly mongodb: {
    readonly uri: string;
    readonly replicaSet: string;
    readonly connectTimeoutMs: number;
  };
  readonly redis: {
    readonly url: string;
    readonly connectTimeoutMs: number;
    readonly queuePrefix: string;
  };
  readonly auth: {
    readonly adminJwtCurrentKeyId: string;
    readonly adminJwtCurrentSecret: string;
    readonly adminJwtPreviousKeyId?: string;
    readonly adminJwtPreviousSecret?: string;
    readonly merchantStepUpSecret: string;
    readonly adminAccessTtlSec: number;
    readonly adminRefreshTtlSec: number;
    readonly merchantStepUpTtlSec: number;
    readonly walletNetworkAllowlist: Readonly<Record<string, "mainnet" | "testnet">>;
  };
  readonly rpc: {
    readonly providers: Readonly<
      Record<string, { readonly operatorId: string; readonly url: string }>
    >;
    readonly requestTimeoutMs: number;
  };
}

export class ConfigurationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super("Runtime configuration is invalid");
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

function selectKnownEnvironment(source: NodeJS.ProcessEnv): Record<string, unknown> {
  return Object.fromEntries(environmentKeys.map((key) => [key, source[key]]));
}

function assertMongoReplicaSet(uri: string, expectedReplicaSet: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ConfigurationError(["MONGODB_URI must be a valid MongoDB URI"]);
  }

  if (parsed.protocol !== "mongodb:" && parsed.protocol !== "mongodb+srv:") {
    throw new ConfigurationError(["MONGODB_URI must use mongodb or mongodb+srv"]);
  }

  const configuredReplicaSet = parsed.searchParams.get("replicaSet");
  if (configuredReplicaSet !== expectedReplicaSet) {
    throw new ConfigurationError([
      "MONGODB_URI replicaSet must match MONGODB_REPLICA_SET",
    ]);
  }
}

function assertRedisUrl(url: string): void {
  const protocol = new URL(url).protocol;
  if (protocol !== "redis:" && protocol !== "rediss:") {
    throw new ConfigurationError(["REDIS_URL must use redis or rediss"]);
  }
}

function assertRpcProviderCatalog(
  catalog: Readonly<
    Record<string, { readonly operatorId: string; readonly url: string }>
  >,
  nodeEnv: "development" | "test" | "production",
): void {
  const operators = new Set<string>();
  for (const provider of Object.values(catalog)) {
    let parsed: URL;
    try {
      parsed = new URL(provider.url);
    } catch {
      throw new ConfigurationError(["RPC_PROVIDER_CATALOG contains an invalid URL"]);
    }
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      (nodeEnv === "production"
        ? parsed.protocol !== "https:"
        : parsed.protocol !== "https:" && parsed.protocol !== "http:")
    ) {
      throw new ConfigurationError(["RPC_PROVIDER_CATALOG contains an unsafe URL"]);
    }
    operators.add(provider.operatorId);
  }
  if (operators.size < 2) {
    throw new ConfigurationError([
      "RPC_PROVIDER_CATALOG requires at least two independent operators",
    ]);
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const result = environmentSchema.safeParse(selectKnownEnvironment(source));
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  assertMongoReplicaSet(result.data.MONGODB_URI, result.data.MONGODB_REPLICA_SET);
  assertRedisUrl(result.data.REDIS_URL);
  assertRpcProviderCatalog(result.data.RPC_PROVIDER_CATALOG, result.data.NODE_ENV);
  const previousKeyId =
    result.data.ADMIN_JWT_PREVIOUS_KEY_ID === ""
      ? undefined
      : result.data.ADMIN_JWT_PREVIOUS_KEY_ID;
  const previousSecret =
    result.data.ADMIN_JWT_PREVIOUS_SECRET === ""
      ? undefined
      : result.data.ADMIN_JWT_PREVIOUS_SECRET;
  if ((previousKeyId === undefined) !== (previousSecret === undefined)) {
    throw new ConfigurationError([
      "ADMIN_JWT_PREVIOUS_KEY_ID and ADMIN_JWT_PREVIOUS_SECRET must be configured together",
    ]);
  }

  return Object.freeze({
    nodeEnv: result.data.NODE_ENV,
    logLevel: result.data.LOG_LEVEL,
    serviceName: result.data.SERVICE_NAME,
    api: Object.freeze({ host: result.data.API_HOST, port: result.data.API_PORT }),
    shutdownTimeoutMs: result.data.SHUTDOWN_TIMEOUT_MS,
    mongodb: Object.freeze({
      uri: result.data.MONGODB_URI,
      replicaSet: result.data.MONGODB_REPLICA_SET,
      connectTimeoutMs: result.data.MONGODB_CONNECT_TIMEOUT_MS,
    }),
    redis: Object.freeze({
      url: result.data.REDIS_URL,
      connectTimeoutMs: result.data.REDIS_CONNECT_TIMEOUT_MS,
      queuePrefix: result.data.QUEUE_PREFIX,
    }),
    auth: Object.freeze({
      adminJwtCurrentKeyId: result.data.ADMIN_JWT_CURRENT_KEY_ID,
      adminJwtCurrentSecret: result.data.ADMIN_JWT_CURRENT_SECRET,
      ...(previousKeyId === undefined ? {} : { adminJwtPreviousKeyId: previousKeyId }),
      ...(previousSecret === undefined
        ? {}
        : { adminJwtPreviousSecret: previousSecret }),
      merchantStepUpSecret: result.data.MERCHANT_STEP_UP_SECRET,
      adminAccessTtlSec: result.data.ADMIN_ACCESS_TTL_SEC,
      adminRefreshTtlSec: result.data.ADMIN_REFRESH_TTL_SEC,
      merchantStepUpTtlSec: result.data.MERCHANT_STEP_UP_TTL_SEC,
      walletNetworkAllowlist: Object.freeze(result.data.WALLET_NETWORK_ALLOWLIST),
    }),
    rpc: Object.freeze({
      providers: Object.freeze(
        Object.fromEntries(
          Object.entries(result.data.RPC_PROVIDER_CATALOG).map(
            ([providerId, provider]) => [providerId, Object.freeze(provider)],
          ),
        ),
      ),
      requestTimeoutMs: result.data.RPC_REQUEST_TIMEOUT_MS,
    }),
  });
}
