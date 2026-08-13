import { z } from "zod";

export const processNames = ["api", "watcher", "processor", "scheduler"] as const;
export type ProcessName = (typeof processNames)[number];

const integerFromEnvironment = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

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

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const result = environmentSchema.safeParse(selectKnownEnvironment(source));
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  assertMongoReplicaSet(result.data.MONGODB_URI, result.data.MONGODB_REPLICA_SET);
  assertRedisUrl(result.data.REDIS_URL);

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
  });
}
