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

const evmAddressFromList = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const sanctionsStaticList = z
  .string()
  .trim()
  .min(2)
  .max(1_048_576)
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
    const entry = parsed as Record<string, unknown>;
    const listVersion = entry["listVersion"];
    const addresses = entry["addresses"];
    if (
      Object.keys(entry).some((key) => key !== "listVersion" && key !== "addresses") ||
      typeof listVersion !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(listVersion) ||
      !Array.isArray(addresses) ||
      addresses.length > 10_000
    ) {
      context.addIssue({
        code: "custom",
        message: "contains an invalid sanctions list",
      });
      return z.NEVER;
    }
    const rawAddresses: unknown[] = addresses;
    const normalizedAddresses: string[] = [];
    for (const address of rawAddresses) {
      if (
        typeof address !== "string" ||
        !evmAddressFromList.safeParse(address).success
      ) {
        context.addIssue({
          code: "custom",
          message: "contains an invalid sanctions address",
        });
        return z.NEVER;
      }
      normalizedAddresses.push(address.toLowerCase());
    }
    return {
      listVersion,
      addresses: [...new Set(normalizedAddresses)].sort(),
    };
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
    PAYMENT_EXPIRY_MIN_SEC: integerFromEnvironment(60, 86_400).default(300),
    PAYMENT_EXPIRY_MAX_SEC: integerFromEnvironment(60, 86_400).default(7_200),
    PAYMENT_EXPIRY_DEFAULT_SEC: integerFromEnvironment(60, 86_400).default(900),
    IDEMPOTENCY_TTL_SEC: integerFromEnvironment(300, 604_800).default(86_400),
    PAYMENT_CREATE_RATE_LIMIT_PER_MINUTE: integerFromEnvironment(1, 1_000).default(30),
    INGESTION_HMAC_CURRENT_KEY_ID: z.string().trim().min(1).max(128),
    INGESTION_HMAC_CURRENT_SECRET: secretFromEnvironment,
    INGESTION_HMAC_PREVIOUS_KEY_ID: z
      .string()
      .trim()
      .max(128)
      .optional()
      .or(z.literal("")),
    INGESTION_HMAC_PREVIOUS_SECRET: optionalSecretFromEnvironment,
    INGESTION_TIMESTAMP_SKEW_SEC: integerFromEnvironment(30, 3_600).default(300),
    INGESTION_NONCE_TTL_SEC: integerFromEnvironment(60, 604_800).default(600),
    INTERNAL_INGESTION_BASE_URL: z.url(),
    WATCHER_POLL_INTERVAL_MS: integerFromEnvironment(100, 60_000).default(2_000),
    WATCHER_BATCH_SIZE: integerFromEnvironment(1, 100).default(10),
    WATCHER_REGISTRY_REFRESH_SEC: integerFromEnvironment(5, 3_600).default(30),
    WATCHER_INITIAL_LOOKBACK_BLOCKS: integerFromEnvironment(0, 100_000).default(0),
    OVERPAYMENT_ALLOW: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    LATE_PAYMENT_GRACE_SEC: integerFromEnvironment(60, 86_400).default(900),
    CONFIRMATION_POLL_INTERVAL_MS: integerFromEnvironment(500, 60_000).default(5_000),
    REORG_MAX_SCAN_BLOCKS: integerFromEnvironment(2, 10_000).default(200),
    SANCTIONS_STATIC_LIST: sanctionsStaticList,
    SCREENING_CACHE_TTL_SEC: integerFromEnvironment(300, 2_592_000).default(604_800),
    SCREENING_LIST_MAX_AGE_SEC: integerFromEnvironment(60, 31_536_000).default(604_800),
    WEBHOOK_HMAC_CURRENT_KEY_ID: z.string().trim().min(1).max(128),
    WEBHOOK_HMAC_CURRENT_SECRET: secretFromEnvironment,
    WEBHOOK_HMAC_PREVIOUS_KEY_ID: z
      .string()
      .trim()
      .max(128)
      .optional()
      .or(z.literal("")),
    WEBHOOK_HMAC_PREVIOUS_SECRET: optionalSecretFromEnvironment,
    WEBHOOK_DELIVERY_TIMEOUT_MS: integerFromEnvironment(500, 60_000).default(10_000),
    WEBHOOK_MAX_ATTEMPTS: integerFromEnvironment(1, 20).default(8),
    WEBHOOK_RETENTION_SEC: integerFromEnvironment(3_600, 2_592_000).default(604_800),
    SCHEDULER_LEASE_TTL_SEC: integerFromEnvironment(10, 600).default(60),
    SCHEDULER_EXPIRY_SWEEP_SEC: integerFromEnvironment(5, 3_600).default(30),
    SCHEDULER_CONFIRMATION_RECHECK_SEC: integerFromEnvironment(10, 3_600).default(60),
    SCHEDULER_STUCK_PAYMENT_SEC: integerFromEnvironment(60, 86_400).default(300),
    SCHEDULER_SCREENING_RECHECK_SEC: integerFromEnvironment(60, 86_400).default(300),
    SCHEDULER_REGISTRY_REFRESH_SEC: integerFromEnvironment(10, 3_600).default(60),
    SCHEDULER_WEBHOOK_SWEEP_SEC: integerFromEnvironment(5, 3_600).default(30),
    SCHEDULER_RETENTION_SEC: integerFromEnvironment(300, 86_400).default(3_600),
    STUCK_PAYMENT_THRESHOLD_SEC: integerFromEnvironment(60, 86_400).default(1_800),
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
  readonly payments: {
    readonly expiryMinSec: number;
    readonly expiryMaxSec: number;
    readonly expiryDefaultSec: number;
    readonly idempotencyTtlSec: number;
    readonly createRateLimitPerMinute: number;
  };
  readonly ingestion: {
    readonly hmacCurrentKeyId: string;
    readonly hmacCurrentSecret: string;
    readonly hmacPreviousKeyId?: string;
    readonly hmacPreviousSecret?: string;
    readonly timestampSkewSec: number;
    readonly nonceTtlSec: number;
    readonly internalBaseUrl: string;
  };
  readonly watcher: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly registryRefreshSec: number;
    readonly initialLookbackBlocks: number;
  };
  readonly processing: {
    readonly overpaymentAllow: boolean;
    readonly latePaymentGraceSec: number;
    readonly confirmationPollIntervalMs: number;
    readonly reorgMaxScanBlocks: number;
  };
  readonly webhooks: {
    readonly hmacCurrentKeyId: string;
    readonly hmacCurrentSecret: string;
    readonly hmacPreviousKeyId?: string;
    readonly hmacPreviousSecret?: string;
    readonly deliveryTimeoutMs: number;
    readonly maxAttempts: number;
    readonly retentionSec: number;
  };
  readonly scheduler: {
    readonly leaseTtlSec: number;
    readonly expirySweepSec: number;
    readonly confirmationRecheckSec: number;
    readonly stuckPaymentSec: number;
    readonly screeningRecheckSec: number;
    readonly registryRefreshSec: number;
    readonly webhookSweepSec: number;
    readonly retentionSec: number;
    readonly stuckPaymentThresholdSec: number;
  };
  readonly compliance: {
    readonly sanctionsStaticList: {
      readonly listVersion: string;
      readonly addresses: readonly string[];
    };
    readonly screeningCacheTtlSec: number;
    readonly screeningListMaxAgeSec: number;
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

function assertPaymentExpiry(minSec: number, maxSec: number, defaultSec: number): void {
  if (minSec > maxSec) {
    throw new ConfigurationError([
      "PAYMENT_EXPIRY_MIN_SEC must not exceed PAYMENT_EXPIRY_MAX_SEC",
    ]);
  }
  if (defaultSec < minSec || defaultSec > maxSec) {
    throw new ConfigurationError([
      "PAYMENT_EXPIRY_DEFAULT_SEC must fall within the configured expiry range",
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
  assertPaymentExpiry(
    result.data.PAYMENT_EXPIRY_MIN_SEC,
    result.data.PAYMENT_EXPIRY_MAX_SEC,
    result.data.PAYMENT_EXPIRY_DEFAULT_SEC,
  );
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
  const ingestionPreviousKeyId =
    result.data.INGESTION_HMAC_PREVIOUS_KEY_ID === ""
      ? undefined
      : result.data.INGESTION_HMAC_PREVIOUS_KEY_ID;
  const ingestionPreviousSecret =
    result.data.INGESTION_HMAC_PREVIOUS_SECRET === ""
      ? undefined
      : result.data.INGESTION_HMAC_PREVIOUS_SECRET;
  if (
    (ingestionPreviousKeyId === undefined) !==
    (ingestionPreviousSecret === undefined)
  ) {
    throw new ConfigurationError([
      "INGESTION_HMAC_PREVIOUS_KEY_ID and INGESTION_HMAC_PREVIOUS_SECRET must be configured together",
    ]);
  }
  if (ingestionPreviousKeyId !== undefined) {
    if (ingestionPreviousKeyId === result.data.INGESTION_HMAC_CURRENT_KEY_ID) {
      throw new ConfigurationError([
        "INGESTION_HMAC_PREVIOUS_KEY_ID must differ from INGESTION_HMAC_CURRENT_KEY_ID",
      ]);
    }
    if (ingestionPreviousSecret === result.data.INGESTION_HMAC_CURRENT_SECRET) {
      throw new ConfigurationError([
        "INGESTION_HMAC_PREVIOUS_SECRET must differ from INGESTION_HMAC_CURRENT_SECRET",
      ]);
    }
  }
  if (
    result.data.INGESTION_NONCE_TTL_SEC <
    result.data.INGESTION_TIMESTAMP_SKEW_SEC * 2
  ) {
    throw new ConfigurationError([
      "INGESTION_NONCE_TTL_SEC must cover at least twice the timestamp skew window",
    ]);
  }
  const webhookPreviousKeyId =
    result.data.WEBHOOK_HMAC_PREVIOUS_KEY_ID === ""
      ? undefined
      : result.data.WEBHOOK_HMAC_PREVIOUS_KEY_ID;
  const webhookPreviousSecret =
    result.data.WEBHOOK_HMAC_PREVIOUS_SECRET === ""
      ? undefined
      : result.data.WEBHOOK_HMAC_PREVIOUS_SECRET;
  if ((webhookPreviousKeyId === undefined) !== (webhookPreviousSecret === undefined)) {
    throw new ConfigurationError([
      "WEBHOOK_HMAC_PREVIOUS_KEY_ID and WEBHOOK_HMAC_PREVIOUS_SECRET must be configured together",
    ]);
  }
  if (webhookPreviousKeyId !== undefined) {
    if (webhookPreviousKeyId === result.data.WEBHOOK_HMAC_CURRENT_KEY_ID) {
      throw new ConfigurationError([
        "WEBHOOK_HMAC_PREVIOUS_KEY_ID must differ from WEBHOOK_HMAC_CURRENT_KEY_ID",
      ]);
    }
    if (webhookPreviousSecret === result.data.WEBHOOK_HMAC_CURRENT_SECRET) {
      throw new ConfigurationError([
        "WEBHOOK_HMAC_PREVIOUS_SECRET must differ from WEBHOOK_HMAC_CURRENT_SECRET",
      ]);
    }
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
    payments: Object.freeze({
      expiryMinSec: result.data.PAYMENT_EXPIRY_MIN_SEC,
      expiryMaxSec: result.data.PAYMENT_EXPIRY_MAX_SEC,
      expiryDefaultSec: result.data.PAYMENT_EXPIRY_DEFAULT_SEC,
      idempotencyTtlSec: result.data.IDEMPOTENCY_TTL_SEC,
      createRateLimitPerMinute: result.data.PAYMENT_CREATE_RATE_LIMIT_PER_MINUTE,
    }),
    ingestion: Object.freeze({
      hmacCurrentKeyId: result.data.INGESTION_HMAC_CURRENT_KEY_ID,
      hmacCurrentSecret: result.data.INGESTION_HMAC_CURRENT_SECRET,
      ...(ingestionPreviousKeyId === undefined
        ? {}
        : { hmacPreviousKeyId: ingestionPreviousKeyId }),
      ...(ingestionPreviousSecret === undefined
        ? {}
        : { hmacPreviousSecret: ingestionPreviousSecret }),
      timestampSkewSec: result.data.INGESTION_TIMESTAMP_SKEW_SEC,
      nonceTtlSec: result.data.INGESTION_NONCE_TTL_SEC,
      internalBaseUrl: result.data.INTERNAL_INGESTION_BASE_URL,
    }),
    watcher: Object.freeze({
      pollIntervalMs: result.data.WATCHER_POLL_INTERVAL_MS,
      batchSize: result.data.WATCHER_BATCH_SIZE,
      registryRefreshSec: result.data.WATCHER_REGISTRY_REFRESH_SEC,
      initialLookbackBlocks: result.data.WATCHER_INITIAL_LOOKBACK_BLOCKS,
    }),
    processing: Object.freeze({
      overpaymentAllow: result.data.OVERPAYMENT_ALLOW,
      latePaymentGraceSec: result.data.LATE_PAYMENT_GRACE_SEC,
      confirmationPollIntervalMs: result.data.CONFIRMATION_POLL_INTERVAL_MS,
      reorgMaxScanBlocks: result.data.REORG_MAX_SCAN_BLOCKS,
    }),
    webhooks: Object.freeze({
      hmacCurrentKeyId: result.data.WEBHOOK_HMAC_CURRENT_KEY_ID,
      hmacCurrentSecret: result.data.WEBHOOK_HMAC_CURRENT_SECRET,
      ...(webhookPreviousKeyId === undefined
        ? {}
        : { hmacPreviousKeyId: webhookPreviousKeyId }),
      ...(webhookPreviousSecret === undefined
        ? {}
        : { hmacPreviousSecret: webhookPreviousSecret }),
      deliveryTimeoutMs: result.data.WEBHOOK_DELIVERY_TIMEOUT_MS,
      maxAttempts: result.data.WEBHOOK_MAX_ATTEMPTS,
      retentionSec: result.data.WEBHOOK_RETENTION_SEC,
    }),
    scheduler: Object.freeze({
      leaseTtlSec: result.data.SCHEDULER_LEASE_TTL_SEC,
      expirySweepSec: result.data.SCHEDULER_EXPIRY_SWEEP_SEC,
      confirmationRecheckSec: result.data.SCHEDULER_CONFIRMATION_RECHECK_SEC,
      stuckPaymentSec: result.data.SCHEDULER_STUCK_PAYMENT_SEC,
      screeningRecheckSec: result.data.SCHEDULER_SCREENING_RECHECK_SEC,
      registryRefreshSec: result.data.SCHEDULER_REGISTRY_REFRESH_SEC,
      webhookSweepSec: result.data.SCHEDULER_WEBHOOK_SWEEP_SEC,
      retentionSec: result.data.SCHEDULER_RETENTION_SEC,
      stuckPaymentThresholdSec: result.data.STUCK_PAYMENT_THRESHOLD_SEC,
    }),
    compliance: Object.freeze({
      sanctionsStaticList: Object.freeze({
        listVersion: result.data.SANCTIONS_STATIC_LIST.listVersion,
        addresses: Object.freeze([...result.data.SANCTIONS_STATIC_LIST.addresses]),
      }),
      screeningCacheTtlSec: result.data.SCREENING_CACHE_TTL_SEC,
      screeningListMaxAgeSec: result.data.SCREENING_LIST_MAX_AGE_SEC,
    }),
  });
}
