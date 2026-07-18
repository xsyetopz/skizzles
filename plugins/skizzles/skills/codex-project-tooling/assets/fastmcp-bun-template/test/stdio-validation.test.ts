// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { describe, expect, test } from "bun:test";
import {
  assertHasHealthTool,
  assertHealthOk,
  parseJsonRpcResponse,
} from "../src/stdio-validation.ts";

describe("stdio validation", () => {
  test("accepts a valid JSON-RPC response", () => {
    expect(
      parseJsonRpcResponse('{"jsonrpc":"2.0","id":2,"result":{}}'),
    ).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });

  test("rejects malformed JSON-RPC response input", () => {
    expect(() => parseJsonRpcResponse("not json")).toThrow("invalid JSON-RPC");
  });

  test("rejects responses without a numeric identifier", () => {
    expect(() => parseJsonRpcResponse('{"jsonrpc":"2.0","result":{}}')).toThrow(
      "numeric id",
    );
  });

  test("requires the health tool in a tools/list response", () => {
    expect(() =>
      assertHasHealthTool({ jsonrpc: "2.0", id: 2, result: {} }),
    ).toThrow("tools/list did not include health");
  });

  test("requires health text content to encode an ok snapshot", () => {
    expect(() =>
      assertHealthOk({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: "not json" }] },
      }),
    ).toThrow("health returned invalid JSON");
  });
});
