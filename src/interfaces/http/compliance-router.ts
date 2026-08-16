import { Router, type Request, type RequestHandler, type Response } from "express";
import type { Connection } from "mongoose";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { z } from "zod";

import { AuthService } from "../../application/auth/auth-service.js";
import type { AdminPrincipal } from "../../application/auth/principals.js";
import {
  ComplianceControlError,
  ComplianceService,
} from "../../application/compliance/compliance-service.js";
import type { RuntimeConfig } from "../../config/environment.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { RedisRateLimiter } from "../../infrastructure/auth/rate-limiter.js";
import type { UpdateableSanctionsListProvider } from "../../infrastructure/compliance/updateable-list-provider.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const ingestListSchema = z
  .object({
    listVersion: z.string().trim().min(1).max(128),
    source: z.string().trim().min(1).max(512),
    addresses: z.array(evmAddress).min(1).max(100_000),
    contentSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  })
  .strict();

const reviewDecisionSchema = z
  .object({
    decision: z.enum(["release", "block"]),
    reason: z.string().trim().min(10).max(2000),
    evidence: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

function asyncHandler(
  handler: (request: Request, response: Response) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch(next);
  };
}

function validationError(error: z.ZodError): ApplicationError {
  return new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400, {
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

function parseIdentifier(value: unknown): string {
  const parsed = identifier.safeParse(value);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

function remoteAddress(request: Request): string {
  return request.socket.remoteAddress ?? "unknown";
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  return /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization)?.[1];
}

function requireAdminPrincipal(request: Request): AdminPrincipal {
  if (request.adminPrincipal === undefined) {
    throw new ApplicationError("UNAUTHORIZED", "Authentication failed", 401);
  }
  return request.adminPrincipal;
}

function asApplicationError(error: unknown): unknown {
  if (error instanceof ComplianceControlError) {
    return new ApplicationError(error.code, error.message, error.statusCode);
  }
  return error;
}

export interface ComplianceRouterDependencies {
  readonly connection: Connection;
  readonly redis: Redis;
  readonly config: RuntimeConfig;
  readonly logger: Logger;
  readonly sanctionsProvider?: UpdateableSanctionsListProvider;
}

/**
 * Admin compliance controls (ADR 0013): sanctions-list ingestion, the
 * held-payment review queue, and audited review decisions. Admin-JWT only,
 * rate limited, strict bodies; control errors map to the shared error
 * envelope.
 */
export function createComplianceRouter(
  dependencies: ComplianceRouterDependencies,
): Router {
  const router = Router();
  const auth = new AuthService(
    dependencies.connection,
    new RedisRateLimiter(dependencies.redis),
    dependencies.config,
  );
  const service = new ComplianceService(
    dependencies.connection,
    dependencies.logger,
    dependencies.sanctionsProvider,
  );

  const requireAdmin: RequestHandler = (request, _response, next) => {
    const token = bearerToken(request);
    if (token === undefined) {
      next(new ApplicationError("UNAUTHORIZED", "Authentication failed", 401));
      return;
    }
    auth
      .authenticateAdmin(token, remoteAddress(request))
      .then((principal) => {
        Object.defineProperty(request, "adminPrincipal", { value: principal });
        next();
      })
      .catch(next);
  };

  router.put(
    "/admin/compliance/sanctions-list",
    requireAdmin,
    asyncHandler(async (request, response) => {
      try {
        const result = await service.ingestSanctionsList(
          requireAdminPrincipal(request),
          parseBody(ingestListSchema, request.body),
        );
        response.status(201).json(result);
      } catch (error: unknown) {
        throw asApplicationError(error);
      }
    }),
  );

  router.get(
    "/admin/compliance/holds",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const requested = Number(request.query["limit"]);
      const limit =
        Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
      const holds = await service.listHolds(limit);
      response.status(200).json({ holds });
    }),
  );

  router.post(
    "/admin/compliance/holds/:paymentId/decision",
    requireAdmin,
    asyncHandler(async (request, response) => {
      try {
        const body = parseBody(reviewDecisionSchema, request.body);
        const result = await service.recordReviewDecision(
          requireAdminPrincipal(request),
          {
            paymentId: parseIdentifier(request.params["paymentId"]),
            decision: body.decision,
            reason: body.reason,
            ...(body.evidence === undefined ? {} : { evidence: body.evidence }),
          },
        );
        response.status(201).json(result);
      } catch (error: unknown) {
        throw asApplicationError(error);
      }
    }),
  );

  return router;
}
