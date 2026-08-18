import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { Connection } from "mongoose";
import type { Redis } from "ioredis";
import { z } from "zod";

import type { RuntimeConfig } from "../../config/environment.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { assertNoSigningMaterial } from "../../domain/security/signing-material.js";
import { AuthService } from "../../application/auth/auth-service.js";
import type {
  AdminPrincipal,
  MerchantPrincipal,
} from "../../application/auth/principals.js";
import { MerchantService } from "../../application/merchant/merchant-service.js";
import { MerchantScopedRepositories } from "../../application/merchant/tenant-repositories.js";
import { RedisRateLimiter } from "../../infrastructure/auth/rate-limiter.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const registrationSchema = z.object({ email: z.email().max(320) }).strict();
const adminLoginSchema = z
  .object({ email: z.email().max(320), password: z.string().min(12).max(1024) })
  .strict();
const refreshSchema = z.object({ refreshToken: z.string().min(100).max(512) }).strict();
const lifecycleSchema = z.object({ version }).strict();
const statusSchema = z
  .object({ version, status: z.enum(["suspended", "rejected"]) })
  .strict();
const webhookSchema = z
  .object({ version, webhookUrl: z.string().min(1).max(2048) })
  .strict();
const walletSchema = z
  .object({ chain: identifier, publicExtendedKey: z.string().min(80).max(256) })
  .strict();
const rotateWalletSchema = walletSchema.extend({ version }).strict();

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

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  return match?.[1];
}

function bearerValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  return match?.[1];
}

function merchantPrincipal(request: Request): MerchantPrincipal {
  if (request.merchantPrincipal === undefined) {
    throw new ApplicationError("UNAUTHORIZED", "Authentication failed", 401);
  }
  return request.merchantPrincipal;
}

function adminPrincipal(request: Request): AdminPrincipal {
  if (request.adminPrincipal === undefined) {
    throw new ApplicationError("UNAUTHORIZED", "Authentication failed", 401);
  }
  return request.adminPrincipal;
}

function merchantMiddleware(auth: AuthService): RequestHandler {
  return asyncMiddleware(async (request) => {
    const principal = await auth.authenticateMerchant(
      request.headers["x-oscar-merchant-api-key"],
      remoteAddress(request),
    );
    Object.defineProperty(request, "merchantPrincipal", { value: principal });
  });
}

function adminMiddleware(auth: AuthService): RequestHandler {
  return asyncMiddleware(async (request) => {
    const token = bearerToken(request);
    if (token === undefined) {
      throw new ApplicationError("UNAUTHORIZED", "Authentication failed", 401);
    }
    const principal = await auth.authenticateAdmin(token, remoteAddress(request));
    Object.defineProperty(request, "adminPrincipal", { value: principal });
  });
}

function scopeMiddleware(auth: AuthService, scope: string): RequestHandler {
  return (request, _response, next: NextFunction) => {
    try {
      auth.requireMerchantScope(merchantPrincipal(request), scope);
      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}

export interface MerchantSecurityRouterDependencies {
  readonly connection: Connection;
  readonly redis: Redis;
  readonly config: RuntimeConfig;
}

export function createMerchantSecurityRouter(
  dependencies: MerchantSecurityRouterDependencies,
): Router {
  const router = Router();
  const rateLimiter = new RedisRateLimiter(dependencies.redis);
  const auth = new AuthService(
    dependencies.connection,
    rateLimiter,
    dependencies.config,
  );
  const merchants = new MerchantService(
    dependencies.connection,
    auth,
    dependencies.config,
    dependencies.redis,
  );
  const tenantRepositories = new MerchantScopedRepositories(dependencies.connection);
  const requireMerchant = merchantMiddleware(auth);
  const requireAdmin = adminMiddleware(auth);

  router.post(
    "/merchants",
    asyncHandler(async (request, response) => {
      const body = parseBody(registrationSchema, request.body);
      const result = await merchants.register(body.email);
      response.status(202).json(result);
    }),
  );

  router.post(
    "/admin/auth/login",
    asyncHandler(async (request, response) => {
      const body = parseBody(adminLoginSchema, request.body);
      const tokens = await auth.loginAdmin(
        body.email,
        body.password,
        remoteAddress(request),
      );
      response.status(200).json(tokens);
    }),
  );

  router.post(
    "/admin/auth/refresh",
    asyncHandler(async (request, response) => {
      const body = parseBody(refreshSchema, request.body);
      const tokens = await auth.refreshAdmin(body.refreshToken, remoteAddress(request));
      response.status(200).json(tokens);
    }),
  );

  router.post(
    "/admin/auth/logout",
    requireAdmin,
    asyncHandler(async (request, response) => {
      await auth.logoutAdmin(adminPrincipal(request));
      response.status(204).end();
    }),
  );

  router.post(
    "/admin/merchants/:merchantId/email-verification",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const merchantId = parseIdentifier(request.params["merchantId"]);
      const body = parseBody(lifecycleSchema, request.body);
      const result = await merchants.verifyEmail(
        adminPrincipal(request),
        merchantId,
        body.version,
      );
      response.status(200).json(result);
    }),
  );

  router.post(
    "/admin/merchants/:merchantId/approval",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const merchantId = parseIdentifier(request.params["merchantId"]);
      const body = parseBody(lifecycleSchema, request.body);
      const result = await merchants.approve(
        adminPrincipal(request),
        merchantId,
        body.version,
      );
      response.status(200).json(result);
    }),
  );

  router.patch(
    "/admin/merchants/:merchantId/status",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const merchantId = parseIdentifier(request.params["merchantId"]);
      const body = parseBody(statusSchema, request.body);
      const result = await merchants.changeStatus(
        adminPrincipal(request),
        merchantId,
        body.version,
        body.status,
      );
      response.status(200).json(result);
    }),
  );

  router.post(
    "/merchant/auth/step-up",
    requireMerchant,
    asyncHandler(async (request, response) => {
      const principal = merchantPrincipal(request);
      auth.requireMerchantScope(principal, "merchant:wallets");
      const token = await auth.issueMerchantStepUp(principal);
      response
        .status(200)
        .json({ token, expiresInSec: dependencies.config.auth.merchantStepUpTtlSec });
    }),
  );

  router.post(
    "/merchant/credentials/rotate",
    requireMerchant,
    scopeMiddleware(auth, "merchant:credentials"),
    asyncHandler(async (request, response) => {
      const result = await merchants.rotateCredential(merchantPrincipal(request));
      response.status(200).json(result);
    }),
  );

  router.post(
    "/merchant/credentials/:credentialId/revocation",
    requireMerchant,
    scopeMiddleware(auth, "merchant:credentials"),
    asyncHandler(async (request, response) => {
      const credentialId = parseIdentifier(request.params["credentialId"]);
      await merchants.revokeCredential(merchantPrincipal(request), credentialId);
      response.status(204).end();
    }),
  );

  router.put(
    "/merchant/webhook",
    requireMerchant,
    scopeMiddleware(auth, "merchant:webhook"),
    asyncHandler(async (request, response) => {
      const body = parseBody(webhookSchema, request.body);
      const result = await merchants.updateWebhook(
        merchantPrincipal(request),
        body.version,
        body.webhookUrl,
      );
      response.status(200).json(result);
    }),
  );

  router.post(
    "/merchant/wallets",
    requireMerchant,
    scopeMiddleware(auth, "merchant:wallets"),
    asyncHandler(async (request, response) => {
      try {
        assertNoSigningMaterial(request.body);
      } catch {
        throw new ApplicationError("VALIDATION_ERROR", "Wallet input is invalid", 400);
      }
      const body = parseBody(walletSchema, request.body);
      const result = await merchants.registerWallet(
        merchantPrincipal(request),
        body.chain,
        body.publicExtendedKey,
      );
      response.status(201).json(result);
    }),
  );

  router.put(
    "/merchant/wallets/:xpubId",
    requireMerchant,
    scopeMiddleware(auth, "merchant:wallets"),
    asyncHandler(async (request, response) => {
      try {
        assertNoSigningMaterial(request.body);
      } catch {
        throw new ApplicationError("VALIDATION_ERROR", "Wallet input is invalid", 400);
      }
      const xpubId = parseIdentifier(request.params["xpubId"]);
      const stepUpToken = bearerValue(request.headers["x-oscar-wallet-step-up"]);
      if (stepUpToken === undefined) {
        throw new ApplicationError("UNAUTHORIZED", "Authentication failed", 401);
      }
      const principal = merchantPrincipal(request);
      await auth.consumeMerchantStepUp(stepUpToken, principal);
      const body = parseBody(rotateWalletSchema, request.body);
      const result = await merchants.rotateWallet(
        principal,
        xpubId,
        body.version,
        body.chain,
        body.publicExtendedKey,
      );
      response.status(200).json(result);
    }),
  );

  router.get(
    "/merchant/payments/:paymentId",
    requireMerchant,
    scopeMiddleware(auth, "merchant:read"),
    asyncHandler(async (request, response) => {
      const principal = merchantPrincipal(request);
      const paymentId = parseIdentifier(request.params["paymentId"]);
      const payment = await tenantRepositories.requirePayment(
        principal.merchantId,
        paymentId,
      );
      response.status(200).json({
        paymentId: payment.paymentId,
        status: payment.status,
      });
    }),
  );

  return router;
}
