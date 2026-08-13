import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const fixtureRoot = mkdtempSync(resolve(".ci-negative-"));

function run(command, args) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
}

function requireRejected(name, result, expectedOutput) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error !== undefined) {
    throw new Error(`${name} could not run: ${result.error.message}`);
  }
  if (result.status === 0 || !expectedOutput.test(output)) {
    throw new Error(
      `${name} did not reject its representative failure (exit ${result.status ?? "unknown"}): ${output.trim()}`,
    );
  }
}

function requireSucceeded(name, result) {
  if (result.error !== undefined) {
    throw new Error(`${name} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${name} failed unexpectedly`);
  }
}

try {
  const typeErrorPath = join(fixtureRoot, "type-error.ts");
  writeFileSync(typeErrorPath, "const paymentId: string = 42;\n", "utf8");
  requireRejected(
    "TypeScript gate",
    run(process.execPath, [
      resolve("node_modules", "typescript", "bin", "tsc"),
      "--strict",
      "--noEmit",
      "--skipLibCheck",
      typeErrorPath,
    ]),
    /Type 'number' is not assignable to type 'string'/u,
  );

  const failingTestPath = join(fixtureRoot, "failing.test.js");
  const vitestConfigPath = join(fixtureRoot, "vitest.config.mjs");
  writeFileSync(
    failingTestPath,
    'import { expect, test } from "vitest";\ntest("representative failure", () => expect(1).toBe(2));\n',
    "utf8",
  );
  writeFileSync(
    vitestConfigPath,
    'export default { test: { include: ["**/*.test.js"] } };\n',
    "utf8",
  );
  requireRejected(
    "Test gate",
    run(process.execPath, [
      resolve("node_modules", "vitest", "vitest.mjs"),
      "run",
      "--root",
      fixtureRoot,
      "--config",
      vitestConfigPath,
    ]),
    /1 failed/u,
  );

  const syntheticSecretPath = join(fixtureRoot, "synthetic-credential.txt");
  const scannerConfigPath = join(fixtureRoot, ".gitleaks.toml");
  writeFileSync(
    syntheticSecretPath,
    "SYNTHETIC_COMMITTED_CREDENTIAL=reject-this-fixture\n",
    "utf8",
  );
  writeFileSync(
    scannerConfigPath,
    `[[rules]]
id = "ci-negative-control"
description = "CI committed-secret rejection fixture"
regex = '''SYNTHETIC_COMMITTED_CREDENTIAL[=][^[:space:]]+'''
keywords = ["SYNTHETIC_COMMITTED_CREDENTIAL"]
`,
    "utf8",
  );
  requireSucceeded(
    "Secret fixture Git initialization",
    run("git", ["init", fixtureRoot]),
  );
  requireSucceeded(
    "Secret fixture staging",
    run("git", [
      "-C",
      fixtureRoot,
      "add",
      "synthetic-credential.txt",
      ".gitleaks.toml",
    ]),
  );
  requireSucceeded(
    "Secret fixture commit",
    run("git", [
      "-C",
      fixtureRoot,
      "-c",
      "user.name=Validation",
      "-c",
      "user.email=validation@invalid",
      "commit",
      "-m",
      "Add scanner fixture",
    ]),
  );
  const dockerCommand = process.env["DOCKER_BIN"] ?? "docker";
  requireRejected(
    "Secret gate",
    run(dockerCommand, [
      "run",
      "--rm",
      "-v",
      `${fixtureRoot}:/fixture:ro`,
      "zricethezav/gitleaks:v8.28.0",
      "git",
      "/fixture",
      "--config=/fixture/.gitleaks.toml",
      "--redact",
      "--no-banner",
      "--no-color",
      "--exit-code=1",
    ]),
    /leaks found/iu,
  );

  process.stdout.write(
    "CI negative controls rejected type, test, and secret fixtures\n",
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
