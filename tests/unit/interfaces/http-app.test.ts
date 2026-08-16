import type { AddressInfo } from "node:net";

import pino from "pino";
import { Router, type Router as ExpressRouter } from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../../src/interfaces/http/create-app.js";
import { ApplicationError } from "../../../src/domain/errors/application-error.js";

const servers: ReturnType<ReturnType<typeof createApp>["listen"]>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

async function startApp(
  ready: boolean,
  apiRouters: readonly ExpressRouter[] = [],
): Promise<string> {
  const app = createApp(
    pino({ level: "silent" }),
    {
      isReady: () => Promise.resolve(ready),
    },
    { apiRouters },
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("HTTP application", () => {
  it("reports liveness independently of dependency readiness", async () => {
    const baseUrl = await startApp(false);

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("fails readiness when dependencies are unavailable", async () => {
    const baseUrl = await startApp(false);

    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "not_ready" });
  });

  it("reports readiness when every dependency is available", async () => {
    const baseUrl = await startApp(true);

    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ready" });
  });

  it("returns a consistent not-found envelope without internal details", async () => {
    const baseUrl = await startApp(true);

    const response = await fetch(`${baseUrl}/missing`, {
      headers: { "x-request-id": "test-request" },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Resource not found",
        requestId: "test-request",
      },
    });
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("rejects malformed JSON with a safe validation envelope", async () => {
    const baseUrl = await startApp(true);

    const response = await fetch(`${baseUrl}/health`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "malformed-json",
      },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request body is invalid",
        requestId: "malformed-json",
      },
    });
  });

  it("replaces unsafe request IDs", async () => {
    const baseUrl = await startApp(true);

    const response = await fetch(`${baseUrl}/health`, {
      headers: { "x-request-id": "unsafe request id" },
    });

    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns retry timing for rate-limited requests", async () => {
    const router = Router();
    router.get("/limited", (_request, _response, next) => {
      next(
        new ApplicationError("RATE_LIMITED", "Request rate limit exceeded", 429, {
          retryAfterSec: 37,
        }),
      );
    });
    const baseUrl = await startApp(true, [router]);

    const response = await fetch(`${baseUrl}/api/v1/limited`);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
  });
});
