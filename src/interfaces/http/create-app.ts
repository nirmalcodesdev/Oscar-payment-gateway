import { randomUUID } from "node:crypto";

import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Router,
} from "express";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";

import { ApplicationError } from "../../domain/errors/application-error.js";
import {
  corsAllowlistMiddleware,
  helmet,
} from "../../infrastructure/http/security-middleware.js";
import {
  childTraceContext,
  generateTraceContext,
  parseTraceParent,
  traceParentHeader,
  type TraceContext,
} from "../../infrastructure/observability/trace-context.js";
import {
  apiMetrics,
  httpRequestsTotal,
  httpRequestDurationMs,
} from "../../infrastructure/metrics/registry.js";

// The internal ingestion endpoint verifies HMAC over the exact request bytes
// (ADR 0010). Because this app-level parser is the only JSON body parser a
// request passes through, the raw bytes must be captured here through its
// `verify` hook; a downstream route-local parser never runs once the body has
// been parsed (body-parser marks `req._body` and skips reparsing).
declare module "express-serve-static-core" {
  interface Request {
    rawBody?: Buffer;
  }
}

export interface ReadinessProbe {
  isReady(): Promise<boolean>;
}

export interface OperationalEndpoints {
  /** Per-IP general public limiter; failures fail open (alerted separately). */
  publicRateLimit?: RequestHandler;
  /** Prometheus text rendering with cross-process gauges. */
  renderMetrics(): Promise<string>;
  /** Bounded dependency checks; outcomes must not expose provider identity. */
  readinessChecks?(): Promise<readonly { name: string; ready: boolean }[]>;
}

interface CreateAppOptions {
  readonly apiRouters?: readonly Router[];
  readonly security?: {
    readonly corsAllowedOrigins: readonly string[];
    readonly trustProxyHops?: number;
  };
  readonly operational?: OperationalEndpoints;
}

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

function requestId(request: express.Request): string {
  return typeof request.id === "string" ? request.id : "unknown";
}

function isMalformedJson(error: unknown): error is SyntaxError {
  if (!(error instanceof SyntaxError)) {
    return false;
  }
  const candidate = error as SyntaxError & { status?: unknown; type?: unknown };
  return candidate.status === 400 && candidate.type === "entity.parse.failed";
}

function isPayloadTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; type?: unknown };
  return candidate.status === 413 && candidate.type === "entity.too.large";
}

export function createApp(
  logger: Logger,
  readiness: ReadinessProbe,
  options: CreateAppOptions = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  if (options.security?.trustProxyHops !== undefined) {
    // Hop-count proxy trust (ADR 0016): unset means never trust forwarded
    // headers, so a direct exposure cannot forge rate-limit identities.
    app.set("trust proxy", options.security.trustProxyHops);
  }
  // Security-header baseline (ADR 0016) before anything else runs.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      referrerPolicy: { policy: "no-referrer" },
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );
  // Explicit-origin CORS allowlist; no configured origins means no CORS
  // headers at all (API-only surface).
  app.use(corsAllowlistMiddleware(options.security?.corsAllowedOrigins ?? []));
  app.use(traceContextMiddleware());
  app.use(
    pinoHttp({
      logger,
      genReqId(request, response) {
        const suppliedId = request.headers["x-request-id"];
        const id =
          typeof suppliedId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedId)
            ? suppliedId
            : randomUUID();
        response.setHeader("x-request-id", id);
        return id;
      },
      customProps(request) {
        return {
          requestId: request.id,
          traceId: (request as express.Request & { traceContext?: TraceContext })
            .traceContext?.traceId,
        };
      },
    }),
  );
  // Capture the exact request bytes through the parser's `verify` hook so
  // HMAC signature verification operates on byte-identical input (ADR 0010).
  app.use(
    express.json({
      limit: "64kb",
      strict: true,
      verify: (rawRequest, _rawResponse, buffer) => {
        (rawRequest as express.Request).rawBody = buffer;
      },
    }),
  );

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.get("/ready", (async (_request, response, next) => {
    try {
      const ready = await readiness.isReady();
      const detailChecks = (await options.operational?.readinessChecks?.()) ?? [];
      const detailReady = detailChecks.every((check) => check.ready);
      const overall = ready && detailReady;
      response.status(overall ? 200 : 503).json({
        status: overall ? "ready" : "not_ready",
        checks: detailChecks.map((check) => ({
          name: check.name,
          status: check.ready ? "ready" : "not_ready",
        })),
      });
    } catch (error: unknown) {
      next(error);
    }
  }) satisfies RequestHandler);

  if (options.operational !== undefined) {
    const operational = options.operational;
    app.get("/metrics", (async (_request, response, next) => {
      try {
        const body = await operational.renderMetrics();
        response
          .status(200)
          .setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8")
          .send(body);
      } catch (error: unknown) {
        next(error);
      }
    }) satisfies RequestHandler);
  }

  if (options.operational?.publicRateLimit !== undefined) {
    app.use(options.operational.publicRateLimit);
  }

  for (const router of options.apiRouters ?? []) {
    app.use("/api/v1", router);
  }

  app.use((_request, _response, next) => {
    next(new ApplicationError("NOT_FOUND", "Resource not found", 404));
  });

  // HTTP metrics observe after routing so 404/500 responses count too.
  app.use(
    (request: express.Request, response: express.Response, next: NextFunction) => {
      const startedAt = Date.now();
      response.on("finish", () => {
        const routeClass = request.path.startsWith("/api/v1/")
          ? (request.path.split("/")[3] ?? "root")
          : "operational";
        apiMetrics.increment(httpRequestsTotal, [
          routeClass,
          String(response.statusCode),
        ]);
        apiMetrics.increment(
          httpRequestDurationMs,
          [routeClass],
          Date.now() - startedAt,
        );
      });
      next();
    },
  );

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    void _next;
    const unknownError: unknown = error;
    const applicationError =
      unknownError instanceof ApplicationError
        ? unknownError
        : isMalformedJson(unknownError)
          ? new ApplicationError("VALIDATION_ERROR", "Request body is invalid", 400)
          : isPayloadTooLarge(unknownError)
            ? new ApplicationError("VALIDATION_ERROR", "Request body is too large", 413)
            : undefined;
    const statusCode = applicationError?.statusCode ?? 500;
    const envelope: ErrorEnvelope = {
      error: {
        code: applicationError?.code ?? "INTERNAL_ERROR",
        message: applicationError?.message ?? "An internal error occurred",
        requestId: requestId(request),
        ...(applicationError?.details !== undefined
          ? { details: applicationError.details }
          : {}),
      },
    };

    if (applicationError === undefined) {
      request.log.error({ err: unknownError }, "Unhandled request error");
    }
    const retryAfterSec = applicationError?.details?.["retryAfterSec"];
    if (
      statusCode === 429 &&
      typeof retryAfterSec === "number" &&
      Number.isSafeInteger(retryAfterSec) &&
      retryAfterSec > 0
    ) {
      response.setHeader("retry-after", String(retryAfterSec));
    }
    response.status(statusCode).json(envelope);
  };
  app.use(errorHandler);

  return app;
}

/**
 * W3C trace-context middleware (ADR 0016): accept a valid incoming
 * `traceparent`, generate one when absent, echo the child context in the
 * response, and expose it for downstream propagation.
 */
function traceContextMiddleware(): RequestHandler {
  return (request: Request, response, next) => {
    const header = request.headers["traceparent"];
    const parent = parseTraceParent(Array.isArray(header) ? header[0] : header);
    const context =
      parent === undefined ? generateTraceContext() : childTraceContext(parent);
    Object.defineProperty(request, "traceContext", { value: context });
    response.setHeader("traceparent", traceParentHeader(context));
    next();
  };
}

declare module "express-serve-static-core" {
  interface Request {
    traceContext?: TraceContext;
  }
}
