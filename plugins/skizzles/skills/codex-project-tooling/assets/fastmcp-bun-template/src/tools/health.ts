// biome-ignore lint/correctness/noUnresolvedImports: Biome does not follow FastMCP's package export map.
import type { FastMCP } from "fastmcp";
// biome-ignore lint/correctness/noUnresolvedImports: The generated portable template is checked before its declared dependencies are installed.
import { z } from "zod";
import type { ProjectLifecycle } from "../lifecycle.ts";

export function registerHealthTool(
  server: FastMCP,
  lifecycle: ProjectLifecycle,
): void {
  server.addTool({
    name: "health",
    description: "Return a compact health check for this MCP server.",
    parameters: z.object({
      verbose: z.boolean().optional(),
    }),
    execute: async ({ verbose }) => JSON.stringify(lifecycle.snapshot(verbose)),
  });
}
