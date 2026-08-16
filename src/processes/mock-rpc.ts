import { createHash } from "node:crypto";
import { createServer } from "node:http";

const chainId = BigInt(process.env["RPC_MOCK_CHAIN_ID"] ?? "11155111");
const port = Number(process.env["RPC_MOCK_PORT"] ?? "8545");
const nonStandardToken = "0x2222222222222222222222222222222222222222";
const unsafeNonStandardToken = "0x4444444444444444444444444444444444444444";
const raceToken = "0x7777777777777777777777777777777777777777";
const missingToken = "0x3333333333333333333333333333333333333333";

const baseHead = 100n;
const startedAt = Date.now();

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodedString(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("hex");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 64) * 64, "0");
  return `0x${word(32n)}${word(BigInt(encoded.length / 2))}${padded}`;
}

/** Head advances one block every two seconds so the watcher has work to do. */
function currentHead(): bigint {
  return baseHead + BigInt(Math.floor((Date.now() - startedAt) / 2_000));
}

/** Deterministic block hash so independent mock providers agree exactly. */
function blockHashFor(blockNumber: bigint): string {
  return `0x${createHash("sha256")
    .update(`oscar-mock-block:${chainId}:${blockNumber}`)
    .digest("hex")}`;
}

function blockFor(blockNumber: bigint) {
  return {
    number: `0x${blockNumber.toString(16)}`,
    hash: blockHashFor(blockNumber),
    parentHash:
      blockNumber === 0n ? `0x${"0".repeat(64)}` : blockHashFor(blockNumber - 1n),
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    extraData: "0x",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp: `0x${(1_700_000_000n + blockNumber * 12n).toString(16)}`,
    miner: `0x${"0".repeat(40)}`,
    receiptsRoot: `0x${"0".repeat(64)}`,
    stateRoot: `0x${"0".repeat(64)}`,
    transactionsRoot: `0x${"0".repeat(64)}`,
    logsBloom: `0x${"0".repeat(512)}`,
    size: "0x220",
    baseFeePerBlock: "0x3b9aca00",
    transactions: [],
    uncles: [],
    sha3Uncles: `0x${"0".repeat(64)}`,
    mixHash: `0x${"0".repeat(64)}`,
  };
}

function parseBlockParam(param: unknown): bigint {
  if (typeof param !== "string") return currentHead();
  if (param.startsWith("0x")) return BigInt(param);
  if (param === "earliest") return 0n;
  return currentHead(); // latest, pending, safe, finalized
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
  if (method === "eth_blockNumber")
    return rpcResult(id, `0x${currentHead().toString(16)}`);
  if (method === "eth_getBlockByNumber") {
    const blockNumber = parseBlockParam(params[0]);
    if (blockNumber < 0n || blockNumber > currentHead()) {
      return rpcError(id, "block not found");
    }
    return rpcResult(id, blockFor(blockNumber));
  }
  if (method === "eth_getLogs") return rpcResult(id, []);
  if (method === "eth_getTransactionReceipt") {
    const hash = typeof params[0] === "string" ? params[0] : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
      return rpcError(id, "invalid transaction hash");
    const block = blockFor(currentHead());
    return rpcResult(id, {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash: block.hash,
      blockNumber: block.number,
      from: `0x${"a".repeat(40)}`,
      to: `0x${"b".repeat(40)}`,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      contractAddress: null,
      logs: [],
      logsBloom: `0x${"0".repeat(512)}`,
      status: "0x1",
      effectiveGasPrice: "0x3b9aca00",
      type: "0x2",
    });
  }
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
    if (data.startsWith("0x70a08231")) return rpcResult(id, `0x${word(1_000_000n)}`);
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
