import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net, { type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcess[] = [];
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function connectWithRetry(port: number): Promise<net.Socket> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("TCP proxy did not start before the deadline");
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe("TCP host proxy", () => {
  it("fails closed before listening when its fixed destination is invalid", () => {
    const result = spawnSync(process.execPath, ["docker/tcp-proxy/proxy.js"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        LISTEN_PORT: "3000",
        TARGET_HOST: "https://client-controlled.example",
        TARGET_PORT: "3000",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TARGET_HOST must be a Compose service name");
  });

  it("forwards traffic bidirectionally to the configured service", async () => {
    const backend = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.on("data", (data) => socket.write(`ack:${data.toString("utf8")}`));
    });
    servers.push(backend);
    const targetPort = await listen(backend);
    const listenPort = await reservePort();

    const proxy = spawn(process.execPath, ["docker/tcp-proxy/proxy.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LISTEN_PORT: String(listenPort),
        TARGET_HOST: "localhost",
        TARGET_PORT: String(targetPort),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(proxy);

    const socket = await connectWithRetry(listenPort);
    socket.on("error", () => undefined);
    socket.write("payment-ready");
    const [data] = (await once(socket, "data")) as [Buffer];
    socket.end();

    expect(data.toString("utf8")).toBe("ack:payment-ready");
  });
});
