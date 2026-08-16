import {
  Router,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { Connection } from "mongoose";
import { z } from "zod";

import {
  EventIngestionService,
  type EventEnqueuer,
} from "../../application/ingestion/event-ingestion-service.js";
import type { RuntimeConfig } from "../../config/environment.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import {
  IngestionAuthError,
  IngestionHmacVerifier,
  ingestionHeaderNames,
} from "../../infrastructure/auth/ingestion-hmac.js";
import {
  blockHashPattern,
  evmAddressPattern,
  identifierPattern,
  transactionHashPattern,
} from "../../infrastructure/mongodb/schema-helpers.js";

/**
 * Raw request bytes captured verbatim by `createApp`'s JSON parser `verify`
 * hook (ADR 0010). The HMAC signature covers these exact bytes, so the signed
 * payload is byte-identical to the received body. The capture must live on
 * the app-level parser: it is the only parser a request passes through, so a
 * route-local parser would never run after the body has been consumed. The
 * `rawBody` augmentation itself is declared in `create-app.ts`.
 */
const boundedCounter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ingestEventSchema = z
  .object({
    chain: z.string().regex(identifierPattern),
    transactionHash: z.string().regex(transactionHashPattern),
    logIndex: boundedCounter,
    blockNumber: boundedCounter,
    blockHash: z.string().regex(blockHashPattern),
    contractAddress: z.string().regex(evmAddressPattern),
    fromAddress: z.string().regex(evmAddressPattern),
    toAddress: z.string().regex(evmAddressPattern),
    amount: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(80),
    rawEvent: z.record(z.string(), z.unknown()),
    confirmationsAtIngest: boundedCounter.optional(),
  })
  .strict();

function headerValue(request: Request, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function validationError(error: z.ZodError): ApplicationError {
  return new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400, {
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof IngestionAuthError ||
    (error instanceof ApplicationError && error.code === "UNAUTHORIZED")
  );
}

function asyncHandler(
  handler: (request: Request, response: Response) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch(next);
  };
}

export interface InternalEventsRouterDependencies {
  readonly connection: Connection;
  readonly config: RuntimeConfig;
  readonly queue: EventEnqueuer;
  /** Redis-backed per-IP ingestion limiter (ADR 0016 class policy). */
  readonly ingestionRateLimit?: RequestHandler;
}

/**
 * Internal ingestion endpoint (ADR 0010), mounted only in the `api` process
 * at `/api/v1/internal/on-chain-events`. HMAC verification runs against the
 * captured raw bytes before the parsed body is accepted; the body schema is
 * strict and persistence is a single atomic insert, so unauthenticated or
 * malformed traffic never reaches `on_chain_events`.
 */
export function createInternalEventsRouter(
  dependencies: InternalEventsRouterDependencies,
): Router {
  const router = Router();
  const verifier = new IngestionHmacVerifier(dependencies.connection, {
    config: dependencies.config.ingestion,
  });
  const ingestion = new EventIngestionService(
    dependencies.connection,
    dependencies.queue,
  );

  const verifyHmac: RequestHandler = (request, _response, next) => {
    const body = request.rawBody;
    if (body === undefined) {
      next(new IngestionAuthError("malformed_headers"));
      return;
    }
    verifier
      .verify({
        keyId: headerValue(request, ingestionHeaderNames.keyId),
        timestamp: headerValue(request, ingestionHeaderNames.timestamp),
        nonce: headerValue(request, ingestionHeaderNames.nonce),
        signature: headerValue(request, ingestionHeaderNames.signature),
        body,
      })
      .then(() => next(), next);
  };

  // Authentication failures are mapped to 401 before any body handling;
  // unexpected failures below the auth layer fail closed with 503 so a broken
  // queue or database never masquerades as an accepted event.
  const routerErrorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    void _next;
    const unknownError: unknown = error;
    if (isAuthFailure(unknownError)) {
      const reason =
        unknownError instanceof IngestionAuthError ? unknownError.reason : undefined;
      response.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Internal event authentication failed",
          ...(reason === undefined ? {} : { details: { reason } }),
        },
      });
      return;
    }
    if (unknownError instanceof ApplicationError) {
      response.status(unknownError.statusCode).json({
        error: {
          code: unknownError.code,
          message: unknownError.message,
          ...(unknownError.details === undefined
            ? {}
            : { details: unknownError.details }),
        },
      });
      return;
    }
    request.log.error({ err: unknownError }, "Internal ingestion request failed");
    response.status(503).json({
      error: {
        code: "CHAIN_ERROR",
        message: "Event ingestion is temporarily unavailable",
      },
    });
  };

  if (dependencies.ingestionRateLimit !== undefined) {
    router.use(dependencies.ingestionRateLimit);
  }
  router.post(
    "/internal/on-chain-events",
    verifyHmac,
    asyncHandler(async (request, response) => {
      const parsed = ingestEventSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const { confirmationsAtIngest, ...eventFields } = parsed.data;
      const outcome = await ingestion.ingest({
        ...eventFields,
        ...(confirmationsAtIngest === undefined ? {} : { confirmationsAtIngest }),
      });
      response.status(outcome.replayed ? 200 : 201).json(outcome);
    }),
  );
  router.use(routerErrorHandler);

  return router;
}
