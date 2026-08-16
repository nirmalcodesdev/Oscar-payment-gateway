import { Router, type Request, type RequestHandler, type Response } from "express";
import type { Connection } from "mongoose";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { z } from "zod";

import { AuthService } from "../../application/auth/auth-service.js";
import type { AdminPrincipal } from "../../application/auth/principals.js";
import {
  ReconciliationControlError,
  ReconciliationService,
} from "../../application/reconciliation/reconciliation-service.js";
import type { WebhookDispatcher } from "../../application/webhooks/webhook-outbox.js";
import type { RuntimeConfig } from "../../config/environment.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { RedisRateLimiter } from "../../infrastructure/auth/rate-limiter.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/);
const resolveSchema = z.object({ note: z.string().trim().min(10).max(2000) }).strict();

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
  if (error instanceof ReconciliationControlError) {
    return new ApplicationError(error.code, error.message, error.statusCode);
  }
  return error;
}

export interface ReconciliationRouterDependencies {
  readonly connection: Connection;
  readonly redis: Redis;
  readonly config: RuntimeConfig;
  readonly logger: Logger;
  readonly webhookDispatcher?: WebhookDispatcher;
}

/**
 * Admin reconciliation API (ADR 0015): discrepancy views, annotation
 * resolution, and webhook replay. Admin-JWT only, rate limited; every
 * decision is audited.
 */
export function createReconciliationRouter(
  dependencies: ReconciliationRouterDependencies,
): Router {
  const router = Router();
  const auth = new AuthService(
    dependencies.connection,
    new RedisRateLimiter(dependencies.redis),
    dependencies.config,
  );
  const reconciliation = new ReconciliationService(
    dependencies.connection,
    dependencies.logger,
    dependencies.webhookDispatcher,
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

  router.get(
    "/admin/reconciliation",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const requested = Number(request.query["limit"]);
      const limit =
        Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
      const overview = await reconciliation.overview(limit);
      response.status(200).json(overview);
    }),
  );

  router.post(
    "/admin/reconciliation/annotations/:annotationId/resolve",
    requireAdmin,
    asyncHandler(async (request, response) => {
      try {
        const body = parseBody(resolveSchema, request.body);
        await reconciliation.resolveAnnotation(
          requireAdminPrincipal(request),
          parseIdentifier(request.params["annotationId"]),
          body.note,
        );
        response.status(200).json({ status: "resolved" });
      } catch (error: unknown) {
        throw asApplicationError(error);
      }
    }),
  );

  router.post(
    "/admin/webhooks/:deliveryId/replay",
    requireAdmin,
    asyncHandler(async (request, response) => {
      try {
        const result = await reconciliation.replayWebhook(
          requireAdminPrincipal(request),
          parseIdentifier(request.params["deliveryId"]),
        );
        response.status(200).json(result);
      } catch (error: unknown) {
        throw asApplicationError(error);
      }
    }),
  );

  return router;
}
