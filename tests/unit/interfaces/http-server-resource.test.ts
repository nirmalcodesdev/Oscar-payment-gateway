import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { HttpServerResource } from "../../../src/interfaces/http/http-server-resource.js";

const resources: HttpServerResource[] = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async (resource) => resource.stop()));
});

describe("HttpServerResource", () => {
  it("starts once, reports readiness, and stops idempotently", async () => {
    const resource = new HttpServerResource(express(), {
      host: "127.0.0.1",
      port: 0,
    });
    resources.push(resource);

    await expect(resource.isReady()).resolves.toBe(false);
    await resource.start();
    await resource.start();
    await expect(resource.isReady()).resolves.toBe(true);
    await resource.stop();
    await resource.stop();
    await expect(resource.isReady()).resolves.toBe(false);
  });
});
