// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkspace } from "../src/workspace-policy.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("workspace policy", () => {
  test("accepts an owned, contained package topology", async () => {
    const root = await fixture();
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("rejects ambient, escaping, root-owned, and nested-lock contracts", async () => {
    const root = await fixture();
    const packageRoot = join(root, "packages/example");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify(rootManifest({ fastmcp: "1.0.0" })),
    );
    await writeFile(
      join(packageRoot, "src/index.ts"),
      'import "zod";\nexport * from "../../../outside.ts";\n',
    );
    await writeFile(join(packageRoot, "bun.lock"), "");
    await mkdir(join(root, "runtime"));
    await writeFile(join(root, "runtime/unowned.ts"), "export {};\n");

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("ambient-template-dependency");
    expect(codes).toContain("cross-package-relative-import");
    expect(codes).toContain("root-source");
    expect(codes).toContain("nested-lockfile");
    expect(codes).toContain("undeclared-dependency");
  });

  test("rejects missing and overexposed package entrypoints", async () => {
    const root = await fixture();
    const packageRoot = join(root, "packages/example");
    const manifest = packageManifest();
    manifest.exports = { "./internal": "../outside.ts" };
    manifest.bin = { missing: "./src/missing.ts" };
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(manifest),
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("invalid-exports-target");
    expect(codes).toContain("missing-bin-target");
  });

  test("resolves TypeScript exports through the package exports map", async () => {
    const root = await fixture();
    const packageRoot = join(root, "packages/example");
    const manifest = packageManifest();
    manifest.exports = { ".": "src/index.ts" };
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(manifest),
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("invalid-exports-target");
    expect(codes).toContain("unsafe-export-import");
  });

  test.each([
    ["process exit", "process.exit(23);\n"],
    ["stdout output", 'console.log("import side effect");\n'],
    ["stdin consumption", "await Bun.stdin.text();\n"],
  ])("rejects a TypeScript export with import-time %s", async (_, source) => {
    const root = await fixture();
    await writeFile(join(root, "packages/example/src/index.ts"), source);

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("unsafe-export-import");
  });

  test("rejects local Biome tooling and a check without inherited config", async () => {
    const root = await fixture();
    const packageRoot = join(root, "packages/example");
    const manifest = packageManifest();
    manifest.devDependencies["@biomejs/biome"] = "2.5.4";
    manifest.scripts["check"] = "biome check .";
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(manifest),
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("local-biome-dependency");
    expect(codes).toContain("invalid-biome-command");
  });

  test.each([
    "bunx @biomejs/biome@2.5.3 check --config-path ../../biome.jsonc .",
    "bunx @biomejs/biome@2.5.4 check .",
    "bunx @biomejs/biome@2.5.4 check --config-path ./biome.jsonc .",
    "bunx @biomejs/biome@2.5.4 check --config-path ../../biome.jsonc --vcs-root .. .",
    "echo bunx @biomejs/biome@2.5.4 check --config-path ../../biome.jsonc --vcs-root ../.. .",
  ])("rejects a non-canonical Biome command: %s", async (check) => {
    const root = await fixture();
    const packageRoot = join(root, "packages/example");
    const manifest = packageManifest();
    manifest.scripts["check"] = check;
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(manifest),
    );

    const findings = await validateWorkspace(root);
    expect(findings).toContainEqual({
      code: "invalid-biome-command",
      path: "packages/example",
      message:
        "package check must start with bunx @biomejs/biome@2.5.4 check --config-path ../../biome.jsonc --vcs-root ../..",
    });
  });

  test("accepts the portable FastMCP template's local Biome config command", async () => {
    const root = await fixture();
    const portableRoot = join(
      root,
      "skills/codex-project-tooling/assets/fastmcp-bun-template",
    );
    const rootPackage = rootManifest();
    rootPackage["workspaces"] = [
      "packages/*",
      "skills/codex-project-tooling/assets/fastmcp-bun-template",
    ];
    await writeFile(join(root, "package.json"), JSON.stringify(rootPackage));
    await mkdir(join(portableRoot, "src"), { recursive: true });
    await mkdir(join(portableRoot, "test"), { recursive: true });
    const manifest = packageManifest("codex-fastmcp-template");
    manifest.scripts["check"] =
      "bunx @biomejs/biome@2.5.4 check --config-path ./biome.jsonc ./biome.jsonc ./package.json ./tsconfig.json ./src ./test";
    await writeFile(
      join(portableRoot, "package.json"),
      JSON.stringify(manifest),
    );
    await writeFile(join(portableRoot, "README.md"), "# Portable template\n");
    await writeFile(join(portableRoot, "tsconfig.json"), "{}\n");
    await writeFile(join(portableRoot, "src/index.ts"), "export {};\n");
    await writeFile(join(portableRoot, "src/cli.ts"), "export {};\n");
    await writeFile(join(portableRoot, "test/index.test.ts"), "export {};\n");

    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("rejects the portable local Biome command in an ordinary package", async () => {
    const root = await fixture();
    const packageRoot = join(root, "packages/example");
    const manifest = packageManifest();
    manifest.scripts["check"] =
      "bunx @biomejs/biome@2.5.4 check --config-path biome.jsonc --vcs-root . .";
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(manifest),
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("invalid-biome-command");
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-workspace-policy-"));
  roots.push(root);
  await mkdir(join(root, "packages/example/src"), { recursive: true });
  await mkdir(join(root, "packages/example/test"), { recursive: true });
  await writeFile(join(root, "bun.lock"), "");
  await writeFile(join(root, "package.json"), JSON.stringify(rootManifest()));
  await writeFile(
    join(root, "packages/example/package.json"),
    JSON.stringify(packageManifest()),
  );
  await writeFile(join(root, "packages/example/README.md"), "# Example\n");
  await writeFile(join(root, "packages/example/tsconfig.json"), "{}\n");
  await writeFile(
    join(root, "packages/example/src/index.ts"),
    "export const value = 1;\n",
  );
  await writeFile(
    join(root, "packages/example/src/cli.ts"),
    "#!/usr/bin/env bun\nexport {};\n",
  );
  await writeFile(
    join(root, "packages/example/test/index.test.ts"),
    'import { value } from "../src/index.ts";\nvoid value;\n',
  );
  return root;
}

function rootManifest(
  extraDevDependencies: Record<string, string> = {},
): Record<string, unknown> {
  return {
    ...packageManifest("skizzles"),
    workspaces: ["packages/*"],
    devDependencies: {
      "@types/bun": "^1.3.14",
      "@types/node": "^26.1.1",
      typescript: "^7.0.2",
      ...extraDevDependencies,
    },
  };
}

function packageManifest(name = "@skizzles/example"): {
  name: string;
  version: string;
  private: boolean;
  type: string;
  exports: Record<string, string>;
  bin: Record<string, string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  return {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    exports: { ".": "./src/index.ts" },
    bin: { example: "./src/cli.ts" },
    scripts: {
      build: "bun build ./src/index.ts",
      check:
        "bunx @biomejs/biome@2.5.4 check --config-path ../../biome.jsonc --vcs-root ../.. .",
      test: "bun test ./test",
      typecheck: "tsc --noEmit",
    },
    dependencies: {},
    devDependencies: {
      "@types/bun": "^1.3.14",
      "@types/node": "^26.1.1",
      typescript: "^7.0.2",
    },
  };
}
