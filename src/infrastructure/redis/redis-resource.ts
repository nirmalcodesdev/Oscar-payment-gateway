import { Redis } from "ioredis";

import type { RuntimeConfig } from "../../config/environment.js";
import type { ManagedResource } from "../lifecycle/managed-resource.js";

export class RedisResource implements ManagedResource {
  public readonly name = "redis";
  public readonly client: Redis;

  public constructor(config: RuntimeConfig["redis"]) {
    this.client = new Redis(config.url, {
      lazyConnect: true,
      connectTimeout: config.connectTimeoutMs,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
    });
  }

  public async start(): Promise<void> {
    try {
      await this.client.connect();
      await this.client.ping();
    } catch (error: unknown) {
      this.client.disconnect(false);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.client.status === "ready") {
      await this.client.quit();
      return;
    }
    this.client.disconnect(false);
  }

  public async isReady(): Promise<boolean> {
    if (this.client.status !== "ready") {
      return false;
    }
    await this.client.ping();
    return true;
  }
}
