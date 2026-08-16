import type { RequestHandler } from "express";
import helmet from "helmet";

/**
 * First-party CORS allowlist (ADR 0016). With no configured origins the
 * server emits no CORS headers at all — an API-only deployment surface.
 * Allowed origins get exact reflection plus the credential headers the
 * merchant API requires; disallowed origins get nothing.
 */
export function corsAllowlistMiddleware(
  allowedOrigins: readonly string[],
): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (request, response, next) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && allowed.has(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
      if (request.method === "OPTIONS") {
        response.setHeader(
          "access-control-allow-methods",
          "GET, POST, PUT, PATCH, DELETE",
        );
        response.setHeader(
          "access-control-allow-headers",
          [
            "content-type",
            "authorization",
            "x-oscar-merchant-api-key",
            "x-oscar-wallet-step-up",
            "idempotency-key",
            "x-request-id",
            "traceparent",
          ].join(", "),
        );
        response.setHeader("access-control-max-age", "600");
        response.status(204).end();
        return;
      }
    }
    next();
  };
}

export { helmet };
