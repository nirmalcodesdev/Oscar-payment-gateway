import net from "node:net";
import process from "node:process";

function requiredPort(name) {
  const value = process.env[name];
  if (!/^[1-9]\d{0,4}$/u.test(value ?? "")) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  const port = Number(value);
  if (port > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

const targetHost = process.env.TARGET_HOST;
if (!/^[a-z][a-z0-9-]{0,62}$/u.test(targetHost ?? "")) {
  throw new Error("TARGET_HOST must be a Compose service name");
}

const listenPort = requiredPort("LISTEN_PORT");
const targetPort = requiredPort("TARGET_PORT");

const server = net.createServer((incoming) => {
  const outgoing = net.createConnection({ host: targetHost, port: targetPort });
  incoming.on("error", () => outgoing.destroy());
  outgoing.on("error", () => incoming.destroy());
  incoming.pipe(outgoing);
  outgoing.pipe(incoming);
});

server.on("error", (error) => {
  process.stderr.write(`TCP proxy failed: ${error.message}\n`);
  process.exitCode = 1;
});

server.listen(listenPort, "0.0.0.0");

function shutdown() {
  server.close((error) => {
    process.exit(error === undefined ? 0 : 1);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
