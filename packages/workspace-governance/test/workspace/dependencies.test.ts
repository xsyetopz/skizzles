import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { validateWorkspace } from "../../src/workspace/policy.ts";

type DependencyMapName =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies";
type BinConsumerKind =
  | "optionalDependencies"
  | "peerDependencies"
  | "rootDevDependencies";

const DEPENDENCY_MAPS: DependencyMapName[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("workspace dependency maps", () => {
  it("rejects duplicated dependency metadata and runtime type tooling", async () => {
    const root = await fixture();
    const manifest = packageManifest("@skizzles/example");
    manifest.dependencies["@types/node"] = "^26.1.1";
    manifest.dependencies["typescript"] = "^7.0.2";
    await writeManifest(root, "example", manifest);

    const findings = await validateWorkspace(root);
    expect(findings).toContainEqual({
      code: "duplicate-dependency-metadata",
      path: "packages/example",
      message: "@types/node must be declared in exactly one dependency map",
    });
    expect(findings).toContainEqual({
      code: "duplicate-dependency-metadata",
      path: "packages/example",
      message: "typescript must be declared in exactly one dependency map",
    });
    expect(findings).toContainEqual({
      code: "runtime-dev-tool",
      path: "packages/example",
      message:
        "@types/node is compile-time tooling and must be a development dependency",
    });
  });

  it.each(["optionalDependencies", "peerDependencies"] as const)(
    "rejects malformed package and root %s maps",
    async (map) => {
      const packageRoot = await fixture();
      const manifest: Record<string, unknown> = {
        ...packageManifest(),
        [map]: { "@skizzles/two": 1 },
      };
      await writeFile(
        join(packageRoot, "packages/example/package.json"),
        JSON.stringify(manifest),
      );
      expect(
        (await validateWorkspace(packageRoot)).map(({ code }) => code),
      ).toContain("invalid-package-manifest");

      const root = await fixture();
      const invalidRoot: Record<string, unknown> = { ...rootManifest() };
      invalidRoot[map] = [];
      await writeFile(join(root, "package.json"), JSON.stringify(invalidRoot));
      expect((await validateWorkspace(root)).map(({ code }) => code)).toContain(
        "invalid-root-manifest",
      );
    },
  );

  it.each(["optionalDependencies", "peerDependencies"] as const)(
    "treats internal %s as architectural cycle edges",
    async (map) => {
      const root = await fixture();
      await addPackage(root, "two", "@skizzles/two");
      const first = packageManifest("@skizzles/example");
      first[map]["@skizzles/two"] = "workspace:*";
      const second = packageManifest("@skizzles/two");
      second[map]["@skizzles/example"] = "workspace:*";
      await writeManifest(root, "example", first);
      await writeManifest(root, "two", second);

      expect((await validateWorkspace(root)).map(({ code }) => code)).toContain(
        "package-dependency-cycle",
      );
    },
  );

  it.each(["optionalDependencies", "peerDependencies"] as const)(
    "accepts production imports declared through %s",
    async (map) => {
      const root = await fixture();
      await addPackage(root, "two", "@skizzles/two");
      const manifest = packageManifest("@skizzles/example");
      manifest[map]["@skizzles/two"] = "workspace:*";
      await writeManifest(root, "example", manifest);
      await writeFile(
        join(root, "packages/example/src/index.ts"),
        'import { value } from "@skizzles/two";\nexport { value };\n',
      );

      const codes = (await validateWorkspace(root)).map(({ code }) => code);
      expect(codes).not.toContain("undeclared-dependency");
      expect(codes).not.toContain("private-package-import");
    },
  );

  it.each(DEPENDENCY_MAPS)(
    "requires workspace ranges for internal package %s",
    async (map) => {
      const root = await fixture();
      await addPackage(root, "two", "@skizzles/two");
      const manifest = packageManifest("@skizzles/example");
      manifest[map]["@skizzles/two"] = "^0.1.0";
      await writeManifest(root, "example", manifest);

      expect(await validateWorkspace(root)).toContainEqual({
        code: "workspace-range",
        path: "packages/example",
        message: "@skizzles/two must use workspace:*",
      });
    },
  );

  it("requires workspace ranges for root development dependencies", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const manifest = rootManifest();
    manifest.devDependencies["@skizzles/two"] = "^0.1.0";
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));

    expect(await validateWorkspace(root)).toContainEqual({
      code: "workspace-range",
      path: "package.json",
      message: "@skizzles/two must use workspace:*",
    });
  });

  it.each([
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const)(
    "requires workspace ranges for an unscoped local package in package %s",
    async (map) => {
      const root = await fixture();
      await addPackage(root, "template", "codex-fastmcp-template");
      const manifest = packageManifest("@skizzles/example");
      manifest[map]["codex-fastmcp-template"] = "^0.1.0";
      await writeManifest(root, "example", manifest);

      expect(await validateWorkspace(root)).toContainEqual({
        code: "workspace-range",
        path: "packages/example",
        message: "codex-fastmcp-template must use workspace:*",
      });
    },
  );

  it.each([
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const)(
    "requires workspace ranges for an unscoped local package in root %s",
    async (map) => {
      const root = await fixture();
      await addPackage(root, "template", "codex-fastmcp-template");
      const manifest = rootManifest();
      manifest[map]["codex-fastmcp-template"] = "^0.1.0";
      await writeFile(join(root, "package.json"), JSON.stringify(manifest));

      expect(await validateWorkspace(root)).toContainEqual({
        code: "workspace-range",
        path: "package.json",
        message: "codex-fastmcp-template must use workspace:*",
      });
    },
  );

  it.each([
    ["two", "@skizzles/two"],
    ["template", "codex-fastmcp-template"],
  ] as const)(
    "reports one range finding per consumer and local dependency: %s",
    async (directory, dependency) => {
      const root = await fixture();
      await addPackage(root, directory, dependency);
      const manifest = packageManifest("@skizzles/example");
      manifest.devDependencies[dependency] = "^0.1.0";
      manifest.optionalDependencies[dependency] = "^0.1.0";
      manifest.peerDependencies[dependency] = "^0.1.0";
      await writeManifest(root, "example", manifest);

      const matches = (await validateWorkspace(root)).filter(
        ({ code, message, path }) =>
          code === "workspace-range" &&
          path === "packages/example" &&
          message === `${dependency} must use workspace:*`,
      );
      expect(matches).toHaveLength(1);
    },
  );

  it("does not infer workspace locality from the package namespace", async () => {
    const root = await fixture();
    const manifest = packageManifest("@skizzles/example");
    manifest.devDependencies["@skizzles/external"] = "^0.1.0";
    await writeManifest(root, "example", manifest);

    expect(await validateWorkspace(root)).not.toContainEqual({
      code: "workspace-range",
      path: "packages/example",
      message: "@skizzles/external must use workspace:*",
    });
  });

  it.each(DEPENDENCY_MAPS)("detects a package %s bin consumer", async (map) => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const consumer = packageManifest("@skizzles/example");
    consumer[map]["@skizzles/two"] = "workspace:*";
    await writeManifest(root, "example", consumer);

    expect(await validateWorkspace(root)).toContainEqual(
      binRisk("@skizzles/example (packages/example)"),
    );
  });

  it.each(DEPENDENCY_MAPS)(
    "detects a root %s bin consumer and rejects unsupported root maps",
    async (map) => {
      const root = await fixture();
      await addPackage(root, "two", "@skizzles/two");
      const manifest = rootManifest();
      manifest[map]["@skizzles/two"] = "workspace:*";
      await writeFile(join(root, "package.json"), JSON.stringify(manifest));

      const findings = await validateWorkspace(root);
      expect(findings).toContainEqual(binRisk("skizzles (package.json)"));
      const codes = findings.map(({ code }) => code);
      if (map === "dependencies") {
        expect(codes).toContain("root-runtime-dependency");
      } else if (map === "optionalDependencies") {
        expect(codes).toContain("root-optional-dependency");
      } else if (map === "peerDependencies") {
        expect(codes).toContain("root-peer-dependency");
      }
    },
  );

  it.each([
    "optionalDependencies",
    "peerDependencies",
    "rootDevDependencies",
  ] as const)(
    "catches %s before Bun 1.3.14 mutates the bin target",
    async (consumerKind) => {
      expect(Bun.version).toBe("1.3.14");
      const { binLink, binTarget, root } = await binLinkFixture(consumerKind);
      expect((await validateWorkspace(root)).map(({ code }) => code)).toContain(
        "workspace-dependency-bin-linker-risk",
      );
      expect((await stat(binTarget)).mode & 0o777).toBe(0o644);
      await expect(lstat(binLink)).rejects.toMatchObject({ code: "ENOENT" });

      await rm(join(root, "bun.lock"));
      const install = Bun.spawnSync(
        [process.execPath, "install", "--ignore-scripts"],
        { cwd: root, stderr: "pipe", stdout: "pipe" },
      );

      expect(install.exitCode).toBe(0);
      expect((await stat(binTarget)).mode & 0o777).toBe(0o777);
      expect((await lstat(binLink)).isSymbolicLink()).toBeTrue();
    },
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-dependencies-"));
  roots.push(root);
  await writeFile(join(root, "bun.lock"), "");
  await writeFile(join(root, "package.json"), JSON.stringify(rootManifest()));
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
  await writeFile(join(packageRoot, "test/index.test.ts"), "export {};\n");
}

async function writeManifest(
  root: string,
  directory: string,
  manifest: TestManifest,
): Promise<void> {
  await writeFile(
    join(root, "packages", directory, "package.json"),
    JSON.stringify(manifest),
  );
}

async function binLinkFixture(consumerKind: BinConsumerKind): Promise<{
  binLink: string;
  binTarget: string;
  root: string;
}> {
  const root = await fixture();
  await addPackage(root, "two", "@skizzles/two");
  const consumer = packageManifest("@skizzles/example");
  const provider = packageManifest("@skizzles/two");
  const rootPackage = rootManifest();
  consumer.devDependencies = {};
  provider.devDependencies = {};
  provider.bin = { provider: "./src/cli.ts" };
  rootPackage.devDependencies = {};
  if (consumerKind === "rootDevDependencies") {
    rootPackage.devDependencies["@skizzles/two"] = "workspace:*";
  } else {
    consumer[consumerKind]["@skizzles/two"] = "workspace:*";
  }
  await writeFile(join(root, "package.json"), JSON.stringify(rootPackage));
  await writeManifest(root, "example", consumer);
  await writeManifest(root, "two", provider);
  const binTarget = join(root, "packages/two/src/cli.ts");
  await chmod(binTarget, 0o644);
  const binRoot =
    consumerKind === "rootDevDependencies"
      ? root
      : join(root, "packages/example");
  return {
    binLink: join(binRoot, "node_modules/.bin/provider"),
    binTarget,
    root,
  };
}

function rootManifest(): TestManifest & { workspaces: string[] } {
  const manifest = packageManifest("skizzles");
  manifest.bin = {};
  manifest.scripts = {
    "packages:build": "bun run --workspaces --sequential build",
    "packages:check": "bun run --workspaces --sequential check",
    typecheck: "bun run --workspaces --sequential typecheck",
    test: "bun run --workspaces --sequential test",
  };
  return { ...manifest, workspaces: ["packages/*"] };
}

function packageManifest(name = "@skizzles/example"): TestManifest {
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
    optionalDependencies: {},
    peerDependencies: {},
  };
}

function binRisk(consumer: string): {
  code: string;
  message: string;
  path: string;
} {
  return {
    code: "workspace-dependency-bin-linker-risk",
    path: "packages/two",
    message: `@skizzles/two is consumed by ${consumer} and must not declare bin: Bun 1.3.14 chmods dereferenced workspace binary targets during install`,
  };
}

interface TestManifest {
  name: string;
  version: string;
  private: boolean;
  type: "module";
  exports: Record<string, string>;
  bin: Record<string, string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}
