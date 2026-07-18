// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const templateRoot = fileURLToPath(new URL("..", import.meta.url));

test("copied template has a self-contained Biome check contract", async () => {
  const copiedRoot = await mkdtemp(join(tmpdir(), "codex-fastmcp-template-"));

  try {
    await cp(templateRoot, copiedRoot, { recursive: true });

    const packageJson = JSON.parse(
      await readFile(join(copiedRoot, "package.json"), "utf8"),
    ) as { scripts?: { check?: string } };
    const biomeConfig = JSON.parse(
      await readFile(join(copiedRoot, "biome.jsonc"), "utf8"),
    ) as {
      $schema?: string;
      linter?: {
        rules?: {
          correctness?: { noUnresolvedImports?: string };
          preset?: string;
        };
      };
      root?: boolean;
      vcs?: { enabled?: boolean };
    };

    expect(packageJson.scripts?.check).toBe(
      "bunx @biomejs/biome@2.5.4 check --config-path ./biome.jsonc ./biome.jsonc ./package.json ./tsconfig.json ./src ./test",
    );
    expect(packageJson.scripts?.check).not.toContain("../");
    expect(biomeConfig.$schema).toBe(
      "https://biomejs.dev/schemas/2.5.4/schema.json",
    );
    expect(biomeConfig.root).toBeFalse();
    expect(biomeConfig.vcs?.enabled).toBeFalse();
    expect(biomeConfig.linter?.rules?.preset).toBe("recommended");
    expect(biomeConfig.linter?.rules?.correctness?.noUnresolvedImports).toBe(
      "error",
    );
  } finally {
    await rm(copiedRoot, { force: true, recursive: true });
  }
});
