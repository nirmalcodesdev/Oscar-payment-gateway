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
      if (this.client.status === "wait") {
        await this.client.connect();
      } else if (this.client.status === "connecting") {
        // A BullMQ queue or worker constructed with the shared client may have
        // initiated the connection already; wait for that attempt instead of
        // erroring, while still failing closed if it ultimately fails.
        await new Promise<void>((resolve, reject) => {
          const settle = (): void => {
            this.client.off("ready", onReady);
            this.client.off("error", onError);
          };
          const onReady = (): void => {
            settle();
            resolve();
          };
          const onError = (error: Error): void => {
            settle();
            reject(error);
          };
          this.client.once("ready", onReady);
          this.client.once("error", onError);
        });
      }
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
