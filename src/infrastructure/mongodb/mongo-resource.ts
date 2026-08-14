import mongoose, { type Connection } from "mongoose";

import type { RuntimeConfig } from "../../config/environment.js";
import type { ManagedResource } from "../lifecycle/managed-resource.js";
import { assertDatabaseCompatibility } from "./migrations/runner.js";

interface MongoResourceOptions {
  readonly requireSchemaCompatibility?: boolean;
}

export class MongoResource implements ManagedResource {
  public readonly name = "mongodb";
  readonly #connection: Connection;
  readonly #config: RuntimeConfig["mongodb"];
  readonly #requireSchemaCompatibility: boolean;

  public constructor(
    config: RuntimeConfig["mongodb"],
    options: MongoResourceOptions = {},
  ) {
    this.#config = config;
    this.#requireSchemaCompatibility = options.requireSchemaCompatibility ?? true;
    this.#connection = mongoose.createConnection();
  }

  public get connection(): Connection {
    return this.#connection;
  }

  public async start(): Promise<void> {
    try {
      await this.#connection.openUri(this.#config.uri, {
        replicaSet: this.#config.replicaSet,
        serverSelectionTimeoutMS: this.#config.connectTimeoutMs,
        connectTimeoutMS: this.#config.connectTimeoutMs,
        maxPoolSize: 20,
        minPoolSize: 1,
        autoIndex: false,
        bufferCommands: false,
      });
      const hello = (await this.#connection.db?.admin().command({ hello: 1 })) as
        | { setName?: unknown }
        | undefined;
      if (
        typeof hello?.setName !== "string" ||
        hello.setName !== this.#config.replicaSet
      ) {
        throw new Error("MongoDB replica set identity does not match configuration");
      }
      if (this.#requireSchemaCompatibility) {
        await assertDatabaseCompatibility(this.#connection);
      }
    } catch (error: unknown) {
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#connection.readyState !== mongoose.STATES.disconnected) {
      await this.#connection.close(false);
    }
  }

  public async isReady(): Promise<boolean> {
    if (
      this.#connection.readyState !== mongoose.STATES.connected ||
      this.#connection.db === undefined
    ) {
      return false;
    }
    const result = (await this.#connection.db.admin().command({ ping: 1 })) as {
      ok?: unknown;
    };
    return result.ok === 1;
  }
}
