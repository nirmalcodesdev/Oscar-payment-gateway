import type { Server } from "node:http";

import type { Express } from "express";

import type { RuntimeConfig } from "../../config/environment.js";
import type { ManagedResource } from "../../infrastructure/lifecycle/managed-resource.js";

export class HttpServerResource implements ManagedResource {
  public readonly name = "http-server";
  #server: Server | undefined;

  public constructor(
    private readonly app: Express,
    private readonly config: RuntimeConfig["api"],
  ) {}

  public async start(): Promise<void> {
    if (this.#server !== undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const server = this.app.listen(
        this.config.port,
        this.config.host,
        (error?: Error) => (error === undefined ? resolve() : reject(error)),
      );
      server.once("error", reject);
      this.#server = server;
    });
  }

  public async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  public isReady(): Promise<boolean> {
    return Promise.resolve(this.#server?.listening === true);
  }
}
