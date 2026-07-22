import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { validateWorkspace } from "../../src/workspace/policy.ts";

const roots: string[] = [];
const REVIEWED_BODY_LINES = 650;
const GENERATED_BODY_LINES = 900;
const OVERSIZED_BODY_LINES = 800;
const THICK_ENTRYPOINT_BODY_LINES = 199;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("mandatory workspace architecture fitness", () => {
  it("rejects an architectural defect through the default CLI", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const first = packageManifest("@skizzles/example");
    first.dependencies["@skizzles/two"] = "workspace:*";
    const second = packageManifest("@skizzles/two");
    second.dependencies["@skizzles/example"] = "workspace:*";
    await writeManifest(root, "example", first);
    await writeManifest(root, "two", second);

    const result = Bun.spawnSync(
      [process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), root],
      { stderr: "pipe", stdout: "pipe" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("package-dependency-cycle:");
  });

  it("rejects general package cycles and private package imports", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const first = packageManifest("@skizzles/example");
    first.dependencies["@skizzles/two"] = "workspace:*";
    const second = packageManifest("@skizzles/two");
    second.dependencies["@skizzles/example"] = "workspace:*";
    await writeManifest(root, "example", first);
    await writeManifest(root, "two", second);
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      'import "@skizzles/two/internal";\nexport const value = 1;\n',
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("package-dependency-cycle");
    expect(codes).toContain("private-package-import");
  });

  it("rejects cycles formed only by internal development dependencies", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const first = packageManifest("@skizzles/example");
    first.devDependencies["@skizzles/two"] = "workspace:*";
    const second = packageManifest("@skizzles/two");
    second.devDependencies["@skizzles/example"] = "workspace:*";
    await writeManifest(root, "example", first);
    await writeManifest(root, "two", second);

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("package-dependency-cycle");
  });

  it("requires workspace ranges for internal development dependencies", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const manifest = packageManifest("@skizzles/example");
    manifest.devDependencies["@skizzles/two"] = "^0.1.0";
    await writeManifest(root, "example", manifest);

    const findings = await validateWorkspace(root);
    expect(findings).toContainEqual({
      code: "workspace-range",
      path: "packages/example",
      message: "@skizzles/two must use workspace:*",
    });
  });

  it("enforces current public export and binary budgets", async () => {
    const root = await fixture();
    const manifest = packageManifest("@skizzles/example");
    manifest.exports = {
      ".": "./src/index.ts",
      "./one": "./src/index.ts",
      "./two": "./src/index.ts",
      "./three": "./src/index.ts",
    };
    manifest.bin = {
      one: "./src/cli.ts",
      two: "./src/cli.ts",
      three: "./src/cli.ts",
    };
    await writeManifest(root, "example", manifest);

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("public-export-budget");
    expect(codes).toContain("public-bin-budget");
  });

  it("rejects binaries on packages consumed through workspace dependencies", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const consumer = packageManifest("@skizzles/example");
    consumer.dependencies["@skizzles/two"] = "workspace:*";
    await writeManifest(root, "example", consumer);

    const findings = await validateWorkspace(root);
    expect(findings).toContainEqual({
      code: "workspace-dependency-bin-linker-risk",
      path: "packages/two",
      message:
        "@skizzles/two is consumed by @skizzles/example (packages/example) and must not declare bin: Bun 1.3.14 chmods dereferenced workspace binary targets during install",
    });
  });

  it("allows a declared binary on a package with no workspace consumers", async () => {
    const root = await fixture();

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).not.toContain("workspace-dependency-bin-linker-risk");
  });

  it("enforces source ownership and production-to-test direction", async () => {
    const root = await fixture();
    await writeFile(join(root, "packages/example/orphan.ts"), "export {};\n");
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      'import "../test/support.ts";\nexport const value = 1;\n',
    );
    await writeFile(
      join(root, "packages/example/test/support.ts"),
      "export {};\n",
    );
    await mkdir(join(root, "packages/example/generated"));
    await writeFile(
      join(root, "packages/example/generated/contract.generated.ts"),
      "export {};\n",
    );
    await writeFile(
      join(root, "packages/example/src/generated-consumer.ts"),
      'import "../generated/contract.generated.ts";\n',
    );
    await mkdir(join(root, "packages/example/src/generated"));
    await writeFile(
      join(root, "packages/example/src/generated/value.ts"),
      "export {};\n",
    );
    await writeFile(
      join(root, "packages/example/src/nested-generated-consumer.ts"),
      'import "./generated/value.ts";\n',
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("unowned-package-source");
    expect(codes).toContain("production-to-test-import");
    expect(codes).toContain("production-to-generated-import");
    expect(
      codes.filter((code) => code === "production-to-generated-import"),
    ).toHaveLength(2);
  });

  it("rejects disposable temporary-root ownership in production source", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      [
        'import { mkdtemp as allocate } from "node:fs/promises";',
        'import { tmpdir as temporaryDirectory } from "node:os";',
        "void allocate;",
        "void temporaryDirectory;",
        'export const root = "/private/tmp/example-run";',
        "",
      ].join("\n"),
    );

    const findings = (await validateWorkspace(root)).filter(
      ({ code }) => code === "disposable-temp-ownership",
    );
    expect(findings).toEqual([
      {
        code: "disposable-temp-ownership",
        path: "packages/example/src/index.ts",
        message:
          "hard-coded-host-temp is disposable temporary-root authority owned by @skizzles/run-workspace",
      },
      {
        code: "disposable-temp-ownership",
        path: "packages/example/src/index.ts",
        message:
          "mkdtemp is disposable temporary-root authority owned by @skizzles/run-workspace",
      },
      {
        code: "disposable-temp-ownership",
        path: "packages/example/src/index.ts",
        message:
          "tmpdir is disposable temporary-root authority owned by @skizzles/run-workspace",
      },
    ]);
  });

  it("requires responsibility records above 650 lines and errors above 800", async () => {
    const root = await fixture();
    const packageRoot = join(root, "packages/example");
    await writeFile(
      join(packageRoot, "src/reviewed.ts"),
      `${"// cohesive policy\n".repeat(REVIEWED_BODY_LINES)}export {};\n`,
    );
    await mkdir(join(packageRoot, "generated"));
    await writeFile(
      join(packageRoot, "generated/large.ts"),
      `${"// generated\n".repeat(GENERATED_BODY_LINES)}export {};\n`,
    );
    let codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("missing-file-size-review");
    expect(codes).not.toContain("authored-file-too-large");

    await writeFile(
      join(packageRoot, "architecture-reviews.json"),
      JSON.stringify({
        files: {
          "src/reviewed.ts": {
            owner: "example-policy",
            responsibilities: ["cohesive policy table"],
            reviewTrigger: "split when a second change reason appears",
          },
        },
      }),
    );
    codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).not.toContain("missing-file-size-review");

    await writeFile(
      join(packageRoot, "src/reviewed.ts"),
      `${"// oversized\n".repeat(OVERSIZED_BODY_LINES)}export {};\n`,
    );
    codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("authored-file-too-large");
  });

  it("rejects thick executable entrypoints", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/example/src/cli.ts"),
      `#!/usr/bin/env bun\n${"// orchestration\n".repeat(
        THICK_ENTRYPOINT_BODY_LINES,
      )}export {};\n`,
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("thick-executable-entrypoint");
  });

  it.each([
    ["POSIX", "packages/two/assets/contract.json"],
    ["Windows", "packages\\two\\assets\\contract.json"],
  ])(
    "rejects %s-separated static filesystem reach-through",
    async (_, path) => {
      const root = await fixture();
      await addPackage(root, "two", "@skizzles/two");
      await writeFile(
        join(root, "packages/example/src/index.ts"),
        `export const path = ${JSON.stringify(path)};\n`,
      );

      const findings = await validateWorkspace(root);
      expect(findings).toContainEqual({
        code: "hidden-package-filesystem-reach-through",
        path: "packages/example/src/index.ts",
        message:
          "static path reaches packages/two without artifact composition authority",
      });
    },
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-fitness-"));
  roots.push(root);
  await writeFile(join(root, "bun.lock"), "");
  const rootPackage = packageManifest("skizzles");
  rootPackage.scripts = {
    "packages:build": "bun run --workspaces --sequential build",
    "packages:check": "bun run --workspaces --sequential check",
    typecheck: "bun run --workspaces --sequential typecheck",
    test: "bun run --workspaces --sequential test",
  };
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ ...rootPackage, workspaces: ["packages/*"] }),
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
  await writeFile(
    join(packageRoot, "tsconfig.json"),
    JSON.stringify({
      extends: "../../tsconfig.base.json",
      include: ["src/**/*.ts", "test/**/*.ts"],
    }),
  );
  await writeFile(
    join(packageRoot, "src/index.ts"),
    "export const value = 1;\n",
  );
  await writeFile(
    join(packageRoot, "src/cli.ts"),
    "#!/usr/bin/env bun\nexport {};\n",
  );
  await writeFile(
    join(packageRoot, "test/index.test.ts"),
    'import { value } from "../src/index.ts";\nvoid value;\n',
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

function packageManifest(name: string): {
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
      build: "bun build ./src/index.ts --target=bun --outdir=dist",
      check:
        "bunx @biomejs/biome@2.5.4 check --config-path ../../biome.jsonc --vcs-root ../.. ./src ./test ./package.json ./tsconfig.json",
      test: "bun test ./test",
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    dependencies: {},
    devDependencies: {
      "@types/bun": "^1.3.14",
      "@types/node": "^26.1.1",
      typescript: "^7.0.2",
    },
  };
}
