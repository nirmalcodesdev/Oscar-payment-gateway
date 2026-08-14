import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: [
        "src/config/**/*.ts",
        "src/domain/errors/**/*.ts",
        "src/domain/money/**/*.ts",
        "src/infrastructure/mongodb/models.ts",
        "src/infrastructure/mongodb/schema-helpers.ts",
        "src/infrastructure/mongodb/audit-service.ts",
        "src/infrastructure/mongodb/transactions.ts",
        "src/infrastructure/lifecycle/lifecycle-manager.ts",
        "src/infrastructure/lifecycle/readiness-probe.ts",
        "src/infrastructure/logging/**/*.ts",
        "src/interfaces/http/**/*.ts",
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
