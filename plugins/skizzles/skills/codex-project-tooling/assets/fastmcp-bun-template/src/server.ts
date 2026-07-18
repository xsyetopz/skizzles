import process from "node:process";
// biome-ignore lint/correctness/noUnresolvedImports: Biome does not follow FastMCP's package export map.
import { FastMCP } from "fastmcp";
import { createLifecycle, type ProjectLifecycle } from "./lifecycle.ts";
import { registerHealthTool } from "./tools/health.ts";

export type ServerOptions = {
  repoRoot: string;
  serverName: string;
};

export type ProjectServer = {
  lifecycle: ProjectLifecycle;
  server: FastMCP;
};

export function createServer(options: ServerOptions): ProjectServer {
  const lifecycle = createLifecycle(options);
  const server = new FastMCP({
    name: options.serverName,
    version: "0.1.0",
  });

  registerHealthTool(server, lifecycle);
  return { lifecycle, server };
}

export async function startServer(
  options: ServerOptions = {
    repoRoot: process.cwd(),
    serverName: "project-env",
  },
): Promise<void> {
  const { lifecycle, server } = createServer(options);
  await lifecycle.start();
  await server.start({ transportType: "stdio" });
}
