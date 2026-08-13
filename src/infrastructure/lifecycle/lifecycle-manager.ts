import type { Logger } from "pino";

import type { ManagedResource } from "./managed-resource.js";

export class LifecycleManager {
  readonly #started: ManagedResource[] = [];
  #stopPromise: Promise<void> | undefined;

  public constructor(
    private readonly resources: readonly ManagedResource[],
    private readonly logger: Logger,
  ) {}

  public async start(): Promise<void> {
    try {
      for (const resource of this.resources) {
        this.logger.info({ resource: resource.name }, "Starting resource");
        await resource.start();
        this.#started.push(resource);
      }
    } catch (error: unknown) {
      this.logger.error({ err: error }, "Resource startup failed");
      await this.stop();
      throw error;
    }
  }

  public stop(): Promise<void> {
    this.#stopPromise ??= this.stopStartedResources();
    return this.#stopPromise;
  }

  public async isReady(): Promise<boolean> {
    if (this.#started.length !== this.resources.length) {
      return false;
    }

    const readiness = await Promise.all(
      this.#started.map(async (resource) => {
        try {
          return await resource.isReady();
        } catch (error: unknown) {
          this.logger.warn(
            { err: error, resource: resource.name },
            "Resource readiness check failed",
          );
          return false;
        }
      }),
    );
    return readiness.every(Boolean);
  }

  private async stopStartedResources(): Promise<void> {
    const errors: unknown[] = [];
    for (const resource of [...this.#started].reverse()) {
      try {
        this.logger.info({ resource: resource.name }, "Stopping resource");
        await resource.stop();
      } catch (error: unknown) {
        errors.push(error);
        this.logger.error(
          { err: error, resource: resource.name },
          "Resource stop failed",
        );
      }
    }
    this.#started.length = 0;

    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more resources failed to stop");
    }
  }
}
