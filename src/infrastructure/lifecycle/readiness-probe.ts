import type { Logger } from "pino";

import type { ManagedResource } from "./managed-resource.js";

export class ResourceReadinessProbe {
  public constructor(
    private readonly resources: readonly ManagedResource[],
    private readonly logger: Logger,
  ) {}

  public async isReady(): Promise<boolean> {
    const results = await Promise.all(
      this.resources.map(async (resource) => {
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
    return results.every(Boolean);
  }
}
