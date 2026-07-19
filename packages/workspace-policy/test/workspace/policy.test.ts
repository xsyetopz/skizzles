// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { validateWorkspace } from "../../src/workspace/policy.ts";

const roots: string[] = [];
const descendantPidMarkers: string[] = [];

setDefaultTimeout(10_000);

afterEach(async () => {
  try {
    await Promise.all(
      descendantPidMarkers.splice(0).map(async (marker) => {
        const pid = await readPidMarker(marker);
        if (pid !== undefined) {
          killPid(pid);
          if (!(await pidGone(pid))) {
            throw new Error(`descendant ${pid} survived fail-safe cleanup`);
          }
        }
      }),
    );
  } finally {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  }
});

describe("workspace policy", () => {
  test("accepts an owned, contained package topology", async () => {
    const root = await fixture();
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("normalizes an omitted optional bin to an empty surface", async () => {
    const root = await fixture();
    const manifest = packageManifest();
    const { bin: _, ...withoutBin } = manifest;
    await writeFile(
      join(root, "packages/example/package.json"),
      JSON.stringify(withoutBin),
    );

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

  test("compiles every declared optional binary entrypoint", async () => {
    const root = await fixture();
    const packageRoot = join(root, "packages/example");
    const manifest = packageManifest();
    manifest.bin = { broken: "./src/broken.ts" };
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(manifest),
    );
    await writeFile(join(packageRoot, "src/broken.ts"), "export const =;\n");

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("entrypoint-build-failed");
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

  test("accepts a clean export import beyond the former observation deadline", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      "await Bun.sleep(1_250);\nexport const value = 1;\n",
    );

    const findings = await validateWorkspace(root);
    expect(findings.map(({ code }) => code)).not.toContain(
      "unsafe-export-import",
    );
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

  if (process.platform === "win32") {
    test.skip("kills a silent same-group descendant that inherits export-import pipes (skipped because POSIX process groups are unavailable on Windows)", () => {});
  } else {
    test("kills a silent same-group descendant that inherits export-import pipes", async () => {
      const root = await fixture();
      const marker = registerPidMarker(root, "inherited-pipes.pid");
      await writeFile(
        join(root, "packages/example/src/index.ts"),
        descendantExportSource(marker, "inherit"),
      );

      const findings = await validateWithin(root, marker);
      expect(findings.map(({ code }) => code)).toContain(
        "unsafe-export-import",
      );
      expect(unsafeExportImportMessage(findings)).toContain(
        "exceeded the configured 5000ms lifecycle observation deadline before process exit and both stdout/stderr closures were observed while stdin remained open",
      );
      const pid = await requiredPidMarker(marker);
      expect(await pidGone(pid)).toBeTrue();
    });
  }

  if (process.platform === "win32") {
    test.skip("kills a noisy same-group descendant while its export leader hangs without accumulating output (skipped because POSIX process groups are unavailable on Windows)", () => {});
  } else {
    test("kills a noisy same-group descendant while its export leader hangs without accumulating output", async () => {
      const root = await fixture();
      const marker = registerPidMarker(root, "noisy-descendant.pid");
      await writeFile(
        join(root, "packages/example/src/index.ts"),
        descendantExportSource(marker, "inherit", {
          leaderWaitsOnStdin: true,
          noisy: true,
        }),
      );

      const findings = await validateWithin(root, marker);
      expect(findings.map(({ code }) => code)).toContain(
        "unsafe-export-import",
      );
      expect(unsafeExportImportMessage(findings)).toContain("wrote to stdout");
      const pid = await requiredPidMarker(marker);
      expect(await pidGone(pid)).toBeTrue();
    });
  }

  if (process.platform === "win32") {
    test.skip("kills a silent ignored-stdio same-group descendant after its export leader exits (skipped because POSIX process groups are unavailable on Windows)", () => {});
  } else {
    test("kills a silent ignored-stdio same-group descendant after its export leader exits", async () => {
      const root = await fixture();
      const marker = registerPidMarker(root, "ignored-stdio.pid");
      await writeFile(
        join(root, "packages/example/src/index.ts"),
        descendantExportSource(marker, "ignore"),
      );

      const findings = await validateWithin(root, marker);
      expect(findings.map(({ code }) => code)).toContain(
        "unsafe-export-import",
      );
      expect(unsafeExportImportMessage(findings)).toContain(
        "left a same-group descendant running after import",
      );
      const pid = await requiredPidMarker(marker);
      expect(await pidGone(pid)).toBeTrue();
    });
  }

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

function registerPidMarker(root: string, name: string): string {
  const marker = join(root, name);
  descendantPidMarkers.push(marker);
  return marker;
}

function unsafeExportImportMessage(
  findings: Awaited<ReturnType<typeof validateWorkspace>>,
): string {
  const finding = findings.find(({ code }) => code === "unsafe-export-import");
  if (finding === undefined) {
    throw new Error("missing unsafe-export-import finding");
  }
  return finding.message;
}

function descendantExportSource(
  marker: string,
  stdio: "ignore" | "inherit",
  options: { leaderWaitsOnStdin?: boolean; noisy?: boolean } = {},
): string {
  const descendantScript = options.noisy
    ? 'const chunk = "x".repeat(65536); setInterval(() => process.stdout.write(chunk), 0);'
    : "setInterval(() => {}, 1000);";
  return [
    `const descendant = Bun.spawn([process.execPath, "--eval", ${JSON.stringify(descendantScript)}], { stdin: "ignore", stdout: ${JSON.stringify(stdio)}, stderr: ${JSON.stringify(stdio)} });`,
    `await Bun.write(${JSON.stringify(marker)}, String(descendant.pid));`,
    "descendant.unref();",
    options.leaderWaitsOnStdin ? "await Bun.stdin.text();" : "",
  ].join("\n");
}

async function validateWithin(
  root: string,
  marker: string,
): Promise<Awaited<ReturnType<typeof validateWorkspace>>> {
  const validation = validateWorkspace(root);
  const timeout = Promise.withResolvers<"deadline">();
  const timer = setTimeout(() => timeout.resolve("deadline"), 7_500);
  const outcome = await Promise.race([
    validation.then((findings) => ({ findings })),
    timeout.promise,
  ]);
  clearTimeout(timer);
  if (outcome !== "deadline") {
    return outcome.findings;
  }
  const pid = await readPidMarker(marker);
  if (pid !== undefined) {
    killPid(pid);
  }
  await Promise.race([validation, Bun.sleep(1_000)]);
  throw new Error("workspace validation exceeded the 7500ms test bound");
}

async function requiredPidMarker(marker: string): Promise<number> {
  const pid = await readPidMarker(marker);
  if (pid === undefined) {
    throw new Error(`missing descendant PID marker: ${marker}`);
  }
  return pid;
}

async function readPidMarker(marker: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt(await readFile(marker, "utf8"), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ESRCH")
    ) {
      throw error;
    }
  }
}

async function pidGone(pid: number): Promise<boolean> {
  const deadline = performance.now() + 1_000;
  while (pidExists(pid) && performance.now() < deadline) {
    await Bun.sleep(10);
  }
  return !pidExists(pid);
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

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
