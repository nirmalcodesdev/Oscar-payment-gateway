#!/usr/bin/env node
/**
 * Development static server for the Oscar Gateway dev console (frontend/).
 * Serves the dependency-free SPA on port 4050. The API must allow this
 * origin via CORS_ALLOWED_ORIGINS (the dev compose includes it).
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../frontend", import.meta.url));
const port = Number(process.env.FRONTEND_PORT ?? 4050);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const requested = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(
    root,
    requested === "/" || requested === "\\" ? "index.html" : requested,
  );
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  createReadStream(file, { encoding: "utf8" })
    .on("error", () => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    })
    .pipe(
      response.writeHead(200, {
        "content-type": types[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      }) && response,
    );
}).listen(port, "127.0.0.1", () => {
  console.log(
    `Oscar dev console: http://127.0.0.1:${port} (API CORS origin http://127.0.0.1:${port})`,
  );
});
