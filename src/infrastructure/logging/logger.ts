import pino, { type DestinationStream, type Logger } from "pino";

import type { ProcessName, RuntimeConfig } from "../../config/environment.js";

const redactionPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-oscar-merchant-api-key']",
  "req.headers['x-oscar-signature']",
  "req.headers['x-oscar-wallet-step-up']",
  "headers.authorization",
  "headers.cookie",
  "apiKey",
  "accessToken",
  "refreshToken",
  "publicExtendedKey",
  "token",
  "jwt",
  "signature",
  "secret",
  "password",
  "mongodb.uri",
  "redis.url",
];

export function createLogger(
  config: RuntimeConfig,
  processName: ProcessName | "migrate",
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      base: {
        service: config.serviceName,
        process: processName,
        environment: config.nodeEnv,
      },
      level: config.logLevel,
      redact: {
        paths: redactionPaths,
        censor: "[REDACTED]",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
