import { spawn } from "node:child_process";
import process from "node:process";

const entryPoints = ["api", "watcher", "processor", "scheduler"];

function runWithoutConfiguration(entryPoint) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`dist/processes/${entryPoint}.js`], {
      cwd: process.cwd(),
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

for (const entryPoint of entryPoints) {
  const { code, output } = await runWithoutConfiguration(entryPoint);
  if (code !== 1) {
    throw new Error(`${entryPoint} must exit 1 when configuration is absent`);
  }
  if (!output.includes('"message":"Configuration failed"')) {
    throw new Error(`${entryPoint} did not return the sanitized configuration error`);
  }
  if (/mongodb:\/\/|redis:\/\/|SyntaxError|ConfigurationError|\sat\s/u.test(output)) {
    throw new Error(`${entryPoint} leaked internal configuration or stack details`);
  }
}

process.stdout.write(
  "Compiled process entry points fail closed on invalid configuration\n",
);
