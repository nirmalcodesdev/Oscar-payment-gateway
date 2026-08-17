import { Router, type Request, type RequestHandler, type Response } from "express";
import type { Connection } from "mongoose";
import type { Redis } from "ioredis";
import { z } from "zod";

import { AuthService } from "../../application/auth/auth-service.js";
import type { AdminPrincipal } from "../../application/auth/principals.js";
import { RegistryService } from "../../application/registry/registry-service.js";
import type { RuntimeConfig } from "../../config/environment.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { RedisRateLimiter } from "../../infrastructure/auth/rate-limiter.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedCounter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const decimals = z.number().int().min(0).max(255);
const amount = z.string().regex(/^[1-9][0-9]{0,255}$/);
const providerIds = z.array(identifier).min(2).max(8);
const nativeCurrency = z
  .object({
    name: z.string().trim().min(1).max(128),
    symbol: z.string().trim().min(1).max(32),
    decimals,
  })
  .strict();
const verificationPolicy = z.enum(["event_only", "balance_delta_required"]);

const createChainSchema = z
  .object({
    chainId: identifier,
    networkChainId: boundedCounter,
    name: z.string().trim().min(1).max(128),
    providerIds,
    nativeCurrency,
    requiredConfirmations: boundedCounter,
  })
  .strict();
const updateChainSchema = z
  .object({
    expectedVersion: version,
    name: z.string().trim().min(1).max(128).optional(),
    providerIds: providerIds.optional(),
    nativeCurrency: nativeCurrency.optional(),
    requiredConfirmations: boundedCounter.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.providerIds !== undefined ||
      value.nativeCurrency !== undefined ||
      value.requiredConfirmations !== undefined,
    { message: "At least one chain field must be updated" },
  );
const createTokenSchema = z
  .object({
    tokenId: identifier,
    chain: identifier,
    assetType: z.enum(["erc20", "native"]).optional(),
    symbol: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,32}$/),
    contractAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    decimals,
    minAmount: amount,
    maxAmount: amount,
    verificationPolicy,
  })
  .strict();
const updateTokenSchema = z
  .object({
    expectedVersion: version,
    minAmount: amount.optional(),
    maxAmount: amount.optional(),
    verificationPolicy: verificationPolicy.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minAmount !== undefined ||
      value.maxAmount !== undefined ||
      value.verificationPolicy !== undefined,
    { message: "At least one token field must be updated" },
  );
const activationSchema = z.object({ expectedVersion: version }).strict();
const tokenActivationSchema = z
  .object({
    expectedVersion: version,
    manualReview: z
      .object({
        acknowledged: z.literal(true),
        reason: z.string().trim().min(10).max(1000),
      })
      .strict()
      .optional(),
  })
  .strict();
const normalDeactivationSchema = z
  .object({
    expectedVersion: version,
    force: z.literal(false).optional(),
  })
  .strict();
const forceDeactivationSchema = z
  .object({
    expectedVersion: version,
    force: z.literal(true),
    confirmation: z.string().min(1).max(256),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
const deactivationSchema = z.union([normalDeactivationSchema, forceDeactivationSchema]);

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

export interface AdminRegistryRouterDependencies {
  readonly connection: Connection;
  readonly redis: Redis;
  readonly config: RuntimeConfig;
}

export function createAdminRegistryRouter(
  dependencies: AdminRegistryRouterDependencies,
): Router {
  const router = Router();
  const auth = new AuthService(
    dependencies.connection,
    new RedisRateLimiter(dependencies.redis),
    dependencies.config,
  );
  const registry = new RegistryService(dependencies.connection, dependencies.config);
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

  router.post(
    "/admin/chains",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const result = await registry.createChain(
        requireAdminPrincipal(request),
        parseBody(createChainSchema, request.body),
      );
      response.status(201).json(result);
    }),
  );
  router.patch(
    "/admin/chains/:chainId",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const result = await registry.updateChain(
        requireAdminPrincipal(request),
        parseIdentifier(request.params["chainId"]),
        parseBody(updateChainSchema, request.body),
      );
      response.status(200).json(result);
    }),
  );
  router.post(
    "/admin/chains/:chainId/activation",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const body = parseBody(activationSchema, request.body);
      const result = await registry.activateChain(
        requireAdminPrincipal(request),
        parseIdentifier(request.params["chainId"]),
        body.expectedVersion,
      );
      response.status(200).json(result);
    }),
  );
  router.post(
    "/admin/chains/:chainId/deactivation",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const result = await registry.deactivateChain(
        requireAdminPrincipal(request),
        parseIdentifier(request.params["chainId"]),
        parseBody(deactivationSchema, request.body),
      );
      response.status(200).json(result);
    }),
  );
  router.post(
    "/admin/tokens",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const body = parseBody(createTokenSchema, request.body);
      const result = await registry.createToken(requireAdminPrincipal(request), {
        ...body,
        assetType: body.assetType ?? "erc20",
        ...(body.contractAddress === undefined
          ? {}
          : { contractAddress: body.contractAddress }),
      });
      response.status(201).json(result);
    }),
  );
  router.patch(
    "/admin/tokens/:tokenId",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const result = await registry.updateToken(
        requireAdminPrincipal(request),
        parseIdentifier(request.params["tokenId"]),
        parseBody(updateTokenSchema, request.body),
      );
      response.status(200).json(result);
    }),
  );
  router.post(
    "/admin/tokens/:tokenId/activation",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const body = parseBody(tokenActivationSchema, request.body);
      const result = await registry.activateToken(
        requireAdminPrincipal(request),
        parseIdentifier(request.params["tokenId"]),
        body.expectedVersion,
        body.manualReview,
      );
      response.status(result.enabled ? 200 : 202).json(result);
    }),
  );
  router.post(
    "/admin/tokens/:tokenId/deactivation",
    requireAdmin,
    asyncHandler(async (request, response) => {
      const result = await registry.deactivateToken(
        requireAdminPrincipal(request),
        parseIdentifier(request.params["tokenId"]),
        parseBody(deactivationSchema, request.body),
      );
      response.status(200).json(result);
    }),
  );

  return router;
}
