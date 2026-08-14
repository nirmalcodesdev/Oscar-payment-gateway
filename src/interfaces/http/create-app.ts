import { randomUUID } from "node:crypto";

import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
  type Router,
} from "express";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";

import { ApplicationError } from "../../domain/errors/application-error.js";

export interface ReadinessProbe {
  isReady(): Promise<boolean>;
}

interface CreateAppOptions {
  readonly apiRouters?: readonly Router[];
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

export function createApp(
  logger: Logger,
  readiness: ReadinessProbe,
  options: CreateAppOptions = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
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
        return { requestId: request.id };
      },
    }),
  );
  app.use(express.json({ limit: "64kb", strict: true }));

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.get("/ready", (async (_request, response, next) => {
    try {
      const ready = await readiness.isReady();
      response
        .status(ready ? 200 : 503)
        .json({ status: ready ? "ready" : "not_ready" });
    } catch (error: unknown) {
      next(error);
    }
  }) satisfies RequestHandler);

  for (const router of options.apiRouters ?? []) {
    app.use("/api/v1", router);
  }

  app.use((_request, _response, next) => {
    next(new ApplicationError("NOT_FOUND", "Resource not found", 404));
  });

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    void _next;
    const unknownError: unknown = error;
    const applicationError =
      unknownError instanceof ApplicationError
        ? unknownError
        : isMalformedJson(unknownError)
          ? new ApplicationError("VALIDATION_ERROR", "Request body is invalid", 400)
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
