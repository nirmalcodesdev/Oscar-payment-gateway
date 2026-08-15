import { Router, type Request, type RequestHandler, type Response } from "express";
import type { Connection } from "mongoose";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { z } from "zod";

import { AuthService } from "../../application/auth/auth-service.js";
import type { MerchantPrincipal } from "../../application/auth/principals.js";
import { PaymentService } from "../../application/payments/payment-service.js";
import type { RuntimeConfig } from "../../config/environment.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { RedisRateLimiter } from "../../infrastructure/auth/rate-limiter.js";
import { StaticSanctionsListProvider } from "../../infrastructure/compliance/static-list-provider.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/);
const createPaymentSchema = z
  .object({
    chain: identifier,
    token: identifier,
    amount: z.string().regex(/^[1-9][0-9]{0,77}$/),
    expiresInSec: z.number().int().min(1).max(86_400).optional(),
  })
  .strict();
const idempotencyKeyPattern = /^[A-Za-z0-9._-]{16,255}$/;

function asyncHandler(
  handler: (request: Request, response: Response) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch(next);
  };
}

function asyncMiddleware(handler: (request: Request) => Promise<void>): RequestHandler {
  return (request, _response, next) => {
    handler(request).then(() => next(), next);
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
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function parseIdentifier(value: unknown): string {
  const result = identifier.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function remoteAddress(request: Request): string {
  return request.socket.remoteAddress ?? "unknown";
}

function merchantPrincipal(request: Request): MerchantPrincipal {
  if (request.merchantPrincipal === undefined) {
    throw new ApplicationError("UNAUTHORIZED", "Authentication failed", 401);
  }
  return request.merchantPrincipal;
}

function idempotencyKey(request: Request): string | undefined {
  const value = request.headers["idempotency-key"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !idempotencyKeyPattern.test(value)) {
    throw new ApplicationError("VALIDATION_ERROR", "Idempotency key is invalid", 400);
  }
  return value;
}

export interface PaymentsRouterDependencies {
  readonly connection: Connection;
  readonly redis: Redis;
  readonly config: RuntimeConfig;
  readonly logger: Logger;
}

export function createPaymentsRouter(dependencies: PaymentsRouterDependencies): Router {
  const router = Router();
  const rateLimiter = new RedisRateLimiter(dependencies.redis);
  const auth = new AuthService(
    dependencies.connection,
    rateLimiter,
    dependencies.config,
  );
  const payments = new PaymentService(
    dependencies.connection,
    dependencies.config,
    rateLimiter,
    new StaticSanctionsListProvider(dependencies.config.compliance.sanctionsStaticList),
    dependencies.logger,
  );
  const requireMerchant = asyncMiddleware(async (request) => {
    const principal = await auth.authenticateMerchant(
      request.headers["x-oscar-merchant-api-key"],
      remoteAddress(request),
    );
    Object.defineProperty(request, "merchantPrincipal", { value: principal });
  });
  const requireScope = (scope: string): RequestHandler => {
    return (request, _response, next) => {
      try {
        auth.requireMerchantScope(merchantPrincipal(request), scope);
        next();
      } catch (error: unknown) {
        next(error);
      }
    };
  };

  router.post(
    "/payments",
    requireMerchant,
    requireScope("merchant:payments"),
    asyncHandler(async (request, response) => {
      const key = idempotencyKey(request);
      const body = parseBody(createPaymentSchema, request.body);
      const result = await payments.createPayment(
        merchantPrincipal(request),
        body,
        key,
      );
      response.status(result.statusCode).json(result.body);
    }),
  );

  router.get(
    "/payments/:paymentId",
    requireMerchant,
    requireScope("merchant:read"),
    asyncHandler(async (request, response) => {
      const paymentId = parseIdentifier(request.params["paymentId"]);
      const result = await payments.getPayment(merchantPrincipal(request), paymentId);
      response.status(200).json(result);
    }),
  );

  return router;
}
