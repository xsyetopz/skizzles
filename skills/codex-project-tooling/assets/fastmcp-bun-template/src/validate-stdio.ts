import { spawn } from "node:child_process";
import process from "node:process";
import {
  assertHasHealthTool,
  assertHealthOk,
  type JsonRpcResponse,
  parseJsonRpcResponse,
} from "./stdio-validation.ts";

const child = spawn("bun", ["run", "src/index.ts"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
const responses = new Map<number, JsonRpcResponse>();

child.stdout.on("data", (chunk: Buffer) => {
  stdout += chunk.toString();
  for (;;) {
    const newline = stdout.indexOf("\n");
    if (newline === -1) {
      break;
    }
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (!line) {
      continue;
    }
    let message: JsonRpcResponse;
    try {
      message = parseJsonRpcResponse(line);
    } catch (error) {
      console.error(
        `[validate-stdio] ignoring invalid server response: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    responses.set(message.id, message);
  }
});

child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
});

function send(message: unknown): void {
  if (!child.stdin) {
    throw new Error("stdio validator could not open server stdin");
  }
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitForResponse(id: number): Promise<JsonRpcResponse> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = responses.get(id);
    if (response) {
      if (response.error !== undefined) {
        throw new Error(
          `JSON-RPC ${id} failed: ${JSON.stringify(response.error)}`,
        );
      }
      return response;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for JSON-RPC response ${id}`);
}

try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-validator", version: "0.1.0" },
    },
  });
  await waitForResponse(1);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assertHasHealthTool(await waitForResponse(2));

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "health", arguments: {} },
  });
  assertHealthOk(await waitForResponse(3));

  console.error("[validate-stdio] ok");
} catch (error) {
  console.error(
    `[validate-stdio] failed: ${error instanceof Error ? error.message : error}`,
  );
  if (stderr.trim()) {
    console.error(`[validate-stdio] server stderr:\n${stderr.trim()}`);
  }
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
