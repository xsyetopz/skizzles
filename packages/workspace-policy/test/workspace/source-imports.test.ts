// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkspace } from "../../src/workspace/policy.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("TypeScript source dependency fitness", () => {
  it("rejects a local SCC formed only by type-only declarations", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      'import type { Other } from "./other.ts";\nexport type Value = Other;\n',
    );
    await writeFile(
      join(root, "packages/example/src/other.ts"),
      'export type { Value as Other } from "./index.ts";\n',
    );

    expect(await validateWorkspace(root)).toContainEqual({
      code: "source-module-cycle",
      path: "packages/example/src/index.ts",
      message: "source dependency SCC: src/index.ts <-> src/other.ts",
    });
  });

  it("enforces undeclared and private package type-only edges", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const manifest = packageManifest("@skizzles/example");
    manifest.dependencies["@skizzles/two"] = "workspace:*";
    await writeManifest(root, "example", manifest);
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      [
        'import { type Missing } from "unlisted-types";',
        'export type { Private } from "@skizzles/tw\\u006f/internal";',
        "export type Value = Missing;",
        "",
      ].join("\n"),
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("undeclared-dependency");
    expect(codes).toContain("private-package-import");
  });

  it("accepts adjacent type declarations without scanning inert text", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const manifest = packageManifest("@skizzles/example");
    manifest.dependencies["@skizzles/two"] = "workspace:*";
    await writeManifest(root, "example", manifest);
    await writeFile(
      join(root, "packages/example/src/types.ts"),
      "export type Local = string;\n",
    );
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      [
        '// import type { Fake } from "comment-only";',
        '/* export type { Fake } from "block-comment-only"; */',
        "const text = 'export type { Fake } from \"string-only\";';",
        "const template = `outer $" +
          '{`import type { Fake } from "nested-template-only";`} export type { Fake } from "template-only";`;',
        'const pattern = /export type \\{ Fake \\} from "regex-only"/u;',
        'import type { Value } from "@skizzles/two";',
        'export type { Local } from "./types.ts";',
        "export type Public = Value;",
        "void text;",
        "void template;",
        "void pattern;",
        "",
      ].join("\n"),
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).not.toContain("undeclared-dependency");
    expect(codes).not.toContain("private-package-import");
    expect(codes).not.toContain("source-module-cycle");
  });

  it("allows declared self-references and preserves dynamic import checks", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      [
        'import type { Value as SelfValue } from "@skizzles/example";',
        'void import("unlisted-runtime");',
        'type Deferred = import("unlisted-type-query").Value;',
        'export type { Value as Hidden } from "@skizzles/example/internal";',
        "export type Value = SelfValue;",
        "export type DeferredValue = Deferred;",
        "",
      ].join("\n"),
    );

    const findings = await validateWorkspace(root);
    expect(
      findings.filter(
        ({ code, message }) =>
          code === "undeclared-dependency" &&
          message.startsWith("@skizzles/example "),
      ),
    ).toHaveLength(0);
    expect(findings).toContainEqual({
      code: "undeclared-dependency",
      path: "packages/example/src/index.ts",
      message:
        "unlisted-runtime is not a direct runtime, optional, or peer dependency",
    });
    expect(findings).toContainEqual({
      code: "undeclared-dependency",
      path: "packages/example/src/index.ts",
      message:
        "unlisted-type-query is not a direct runtime, optional, or peer dependency",
    });
    expect(findings).toContainEqual({
      code: "private-package-import",
      path: "packages/example/src/index.ts",
      message:
        "@skizzles/example/internal is not an exported surface of @skizzles/example",
    });
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-source-imports-"));
  roots.push(root);
  await writeFile(join(root, "bun.lock"), "");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      ...packageManifest("skizzles"),
      workspaces: ["packages/*"],
    }),
  );
  await addPackage(root, "example", "@skizzles/example");
  return root;
}

async function addPackage(
  root: string,
  directory: string,
  name: string,
): Promise<void> {
  const packageRoot = join(root, "packages", directory);
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await mkdir(join(packageRoot, "test"), { recursive: true });
  await writeManifest(root, directory, packageManifest(name));
  await writeFile(join(packageRoot, "README.md"), `# ${name}\n`);
  await writeFile(join(packageRoot, "tsconfig.json"), "{}\n");
  await writeFile(
    join(packageRoot, "src/index.ts"),
    "export type Value = number;\n",
  );
  await writeFile(
    join(packageRoot, "test/index.test.ts"),
    'import type { Value } from "../src/index.ts";\nexport type TestValue = Value;\n',
  );
}

async function writeManifest(
  root: string,
  directory: string,
  manifest: ReturnType<typeof packageManifest>,
): Promise<void> {
  await writeFile(
    join(root, "packages", directory, "package.json"),
    JSON.stringify(manifest),
  );
}

function packageManifest(name: string) {
  return {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    exports: { ".": "./src/index.ts" },
    bin: {},
    scripts: {
      build: "bun build ./src/index.ts",
      check:
        "bunx @biomejs/biome@2.5.4 check --config-path ../../biome.jsonc --vcs-root ../.. .",
      test: "bun test ./test",
      typecheck: "tsc --noEmit",
    },
    dependencies: {} as Record<string, string>,
    devDependencies: {
      "@types/bun": "^1.3.14",
      "@types/node": "^26.1.1",
      typescript: "^7.0.2",
    },
  };
}
