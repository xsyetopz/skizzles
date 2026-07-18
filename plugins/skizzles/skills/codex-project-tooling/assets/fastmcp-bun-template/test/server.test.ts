// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { expect, test } from "bun:test";
import { createServer } from "../src/server.ts";

test("creates an import-safe server without starting its lifecycle", () => {
  const { lifecycle, server } = createServer({
    repoRoot: "/tmp/example",
    serverName: "test-server",
  });

  expect(server).toBeDefined();
  expect(lifecycle.snapshot()).toMatchObject({
    server: "test-server",
    stack: "disabled",
  });
});
