import { readFileSync } from "node:fs";
import { URL } from "node:url";
import process from "node:process";

import { load } from "js-yaml";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const compose = load(readFileSync(new URL("../compose.yaml", import.meta.url), "utf8"));
assert(typeof compose === "object" && compose !== null, "Compose root must be a map");

const requiredServices = [
  "mongodb",
  "mongodb-init",
  "mongodb-migrate",
  "redis",
  "api",
  "watcher",
  "processor",
  "scheduler",
  "api-host",
  "mongodb-host",
];
for (const service of requiredServices) {
  assert(
    compose.services?.[service] !== undefined,
    `Missing Compose service: ${service}`,
  );
}

assert(
  compose.networks?.backend?.internal === true,
  "Backend network must be internal",
);
assert(compose.networks?.["host-access"]?.driver === "bridge", "Missing host bridge");
assert(
  compose.services.mongodb.command?.includes("--replSet"),
  "MongoDB must start with replica-set support",
);
assert(
  compose.services.mongodb.healthcheck !== undefined,
  "MongoDB health check is required",
);
assert(
  compose.services.redis.healthcheck !== undefined,
  "Redis health check is required",
);

const processCommands = {
  api: "dist/processes/api.js",
  watcher: "dist/processes/watcher.js",
  processor: "dist/processes/processor.js",
  scheduler: "dist/processes/scheduler.js",
};
for (const [serviceName, entryPoint] of Object.entries(processCommands)) {
  const service = compose.services[serviceName];
  assert(
    Array.isArray(service.command) && service.command.includes(entryPoint),
    `${serviceName} must use its independent process entry point`,
  );
  assert(
    service.security_opt?.includes("no-new-privileges:true"),
    `${serviceName} must disable privilege escalation`,
  );
  assert(service.init === true, `${serviceName} must use an init process`);
}

assert(
  compose.services["mongodb-migrate"].command?.includes("dist/processes/migrate.js"),
  "MongoDB migration service must use the dedicated migration entry point",
);
assert(
  compose.services["mongodb-migrate"].restart === "no",
  "MongoDB migration service must be one-shot",
);
assert(
  compose.services["mongodb-migrate"].environment?.MONGODB_URI?.includes(
    "oscar_migrate",
  ) && !compose.services.api.environment?.MONGODB_URI?.includes("oscar_migrate"),
  "Database migrations must use a credential distinct from runtime services",
);
for (const serviceName of Object.keys(processCommands)) {
  assert(
    compose.services[serviceName].depends_on?.["mongodb-migrate"]?.condition ===
      "service_completed_successfully",
    `${serviceName} must wait for successful database migrations`,
  );
}

for (const serviceName of ["api-host", "mongodb-host"]) {
  assert(
    compose.services[serviceName].networks?.includes("host-access"),
    `${serviceName} must join the host-access network`,
  );
  assert(
    compose.services[serviceName].security_opt?.includes("no-new-privileges:true"),
    `${serviceName} must disable privilege escalation`,
  );
  assert(
    compose.services[serviceName].cap_drop?.includes("ALL"),
    `${serviceName} must drop every Linux capability`,
  );
  assert(
    compose.services[serviceName].read_only === true,
    `${serviceName} must be read-only`,
  );
}

for (const serviceName of [
  "api",
  "mongodb",
  "mongodb-init",
  "mongodb-migrate",
  "watcher",
  "processor",
  "scheduler",
  "redis",
]) {
  assert(
    !compose.services[serviceName].networks?.includes("host-access"),
    `${serviceName} must remain private-only`,
  );
}

assert(
  compose.services["api-host"].environment?.TARGET_HOST === "api" &&
    compose.services["api-host"].environment?.TARGET_PORT === 3000,
  "API host proxy destination must be fixed",
);
assert(
  compose.services["mongodb-host"].environment?.TARGET_HOST === "mongodb" &&
    compose.services["mongodb-host"].environment?.TARGET_PORT === 27017,
  "MongoDB host proxy destination must be fixed",
);
assert(
  compose.services["api-host"].build?.context === "./docker/tcp-proxy" &&
    compose.services["mongodb-host"].build === undefined &&
    compose.services["api-host"].image === compose.services["mongodb-host"].image,
  "TCP proxy image must be built once and shared by both host adapters",
);

for (const [serviceName, service] of Object.entries(compose.services)) {
  for (const port of service.ports ?? []) {
    assert(
      typeof port === "string" && port.startsWith("127.0.0.1:"),
      `${serviceName} ports must bind to loopback only`,
    );
  }
}

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const mongodbDockerfile = readFileSync(
  new URL("../docker/mongodb/Dockerfile", import.meta.url),
  "utf8",
);
const proxyDockerfile = readFileSync(
  new URL("../docker/tcp-proxy/Dockerfile", import.meta.url),
  "utf8",
);
assert(/^USER oscar$/mu.test(dockerfile), "Application image must run as oscar");
assert(
  /install -d -o mongodb -g mongodb -m 0700 \/run\/secrets/u.test(mongodbDockerfile),
  "MongoDB key directory must be private and traversable by mongodb",
);
assert(/^USER node$/mu.test(proxyDockerfile), "TCP proxy image must run as node");
assert(
  /COPY --chown=mongodb:mongodb --chmod=0400 keyfile \/run\/secrets\/mongodb-keyfile/u.test(
    mongodbDockerfile,
  ),
  "MongoDB key file must be readable only by mongodb",
);

process.stdout.write("Compose foundation is structurally valid\n");
