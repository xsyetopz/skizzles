// biome-ignore lint/correctness/noUnresolvedImports: The generated portable template is checked before its declared dependencies are installed.
import { z } from "zod";

const jsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.number().int(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const toolsListResultSchema = z
  .object({
    tools: z.array(z.object({ name: z.string() }).passthrough()),
  })
  .passthrough();

const toolCallResultSchema = z
  .object({
    content: z.array(
      z
        .object({
          type: z.string(),
          text: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const healthSnapshotSchema = z.object({ ok: z.literal(true) }).passthrough();

export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

export function parseJsonRpcResponse(line: string): JsonRpcResponse {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("invalid JSON-RPC response: invalid JSON");
  }

  const parsed = jsonRpcResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      'invalid JSON-RPC response: expected jsonrpc "2.0" with a numeric id',
    );
  }
  return parsed.data;
}

export function assertHasHealthTool(response: JsonRpcResponse): void {
  const parsed = toolsListResultSchema.safeParse(response.result);
  if (
    !(
      parsed.success && parsed.data.tools.some((tool) => tool.name === "health")
    )
  ) {
    throw new Error(
      `tools/list did not include health: ${JSON.stringify(response.result)}`,
    );
  }
}

export function assertHealthOk(response: JsonRpcResponse): void {
  const result = toolCallResultSchema.safeParse(response.result);
  const text = result.success
    ? result.data.content.find(
        (item) => item.type === "text" && item.text !== undefined,
      )?.text
    : undefined;
  if (text === undefined) {
    throw new Error(
      `health returned no text content: ${JSON.stringify(response.result)}`,
    );
  }

  let health: unknown;
  try {
    health = JSON.parse(text);
  } catch {
    throw new Error("health returned invalid JSON");
  }
  if (!healthSnapshotSchema.safeParse(health).success) {
    throw new Error(`health was not ok: ${text}`);
  }
}
