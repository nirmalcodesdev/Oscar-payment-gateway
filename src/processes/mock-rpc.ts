import { createServer } from "node:http";

const chainId = BigInt(process.env["RPC_MOCK_CHAIN_ID"] ?? "11155111");
const port = Number(process.env["RPC_MOCK_PORT"] ?? "8545");
const nonStandardToken = "0x2222222222222222222222222222222222222222";
const unsafeNonStandardToken = "0x4444444444444444444444444444444444444444";
const raceToken = "0x7777777777777777777777777777777777777777";
const missingToken = "0x3333333333333333333333333333333333333333";

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodedString(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("hex");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 64) * 64, "0");
  return `0x${word(32n)}${word(BigInt(encoded.length / 2))}${padded}`;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, message: string) {
  return { jsonrpc: "2.0", id, error: { code: 3, message } };
}

function handleRequest(request: Record<string, unknown>) {
  const id = request["id"];
  const method = request["method"];
  const params = Array.isArray(request["params"])
    ? (request["params"] as unknown[])
    : [];
  if (method === "eth_chainId") return rpcResult(id, `0x${chainId.toString(16)}`);
  if (method === "eth_blockNumber") return rpcResult(id, "0x64");
  if (method === "eth_getCode") {
    const address = typeof params[0] === "string" ? params[0].toLowerCase() : "";
    return rpcResult(id, address === missingToken ? "0x" : "0x6001600055");
  }
  if (method === "eth_call") {
    const call =
      typeof params[0] === "object" && params[0] !== null
        ? (params[0] as Record<string, unknown>)
        : {};
    const address = typeof call["to"] === "string" ? call["to"].toLowerCase() : "";
    const data = typeof call["data"] === "string" ? call["data"].toLowerCase() : "";
    if (data.startsWith("0x313ce567")) return rpcResult(id, `0x${word(6n)}`);
    if (data.startsWith("0x95d89b41")) {
      if (address === nonStandardToken || address === unsafeNonStandardToken) {
        return rpcError(id, "execution reverted");
      }
      return rpcResult(id, encodedString(address === raceToken ? "RACE" : "USDC"));
    }
    if (data.startsWith("0x18160ddd")) {
      return rpcResult(id, `0x${word(1_000_000_000_000n)}`);
    }
    return rpcError(id, "unsupported contract call");
  }
  return rpcError(id, "unsupported method");
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 64 * 1024) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      const result = Array.isArray(parsed)
        ? parsed.map((entry) => handleRequest(entry as Record<string, unknown>))
        : handleRequest(parsed as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(400).end();
    }
  });
});

server.listen(port, "0.0.0.0");

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
