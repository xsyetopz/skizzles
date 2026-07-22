// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { create as createRunWorkspace } from "@skizzles/run-workspace";
import {
  createCommandScope,
  verifyCommandScope,
} from "../../../src/workflow/command/scope.ts";

const limits = Object.freeze({
  byteLimit: 100_000,
  entryLimit: 50,
  scanLimit: 50,
});

describe("command staging scope", () => {
  it("materializes and executes a declared transitive package closure", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "node_modules"));
    await mkdir(join(repository, "node_modules/top-package"));
    await mkdir(join(repository, "node_modules/leaf-package"));
    await writeFile(
      join(repository, "node_modules/top-package/package.json"),
      JSON.stringify({
        name: "top-package",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
        dependencies: { "leaf-package": "1.0.0" },
      }),
    );
    await writeFile(
      join(repository, "node_modules/top-package/index.js"),
      'export { value } from "leaf-package";\n',
    );
    await writeFile(
      join(repository, "node_modules/leaf-package/package.json"),
      JSON.stringify({
        name: "leaf-package",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
    );
    await writeFile(
      join(repository, "node_modules/leaf-package/index.js"),
      'export const value = "dependency-closure";\n',
    );
    const workspace = await createRunWorkspace();
    try {
      const scope = await createCommandScope({
        workspace,
        sequence: 0,
        repositoryRoot: repository,
        limits,
        dependencyPackages: ["top-package"],
        targets: [
          {
            path: "src/value.ts",
            operation: "write",
            candidateBytes: [1],
          },
        ],
      });
      if (scope === undefined) {
        throw new Error("transitive command scope rejected");
      }
      expect(scope.receipt.dependencies).toEqual([
        expect.objectContaining({ name: "leaf-package", direct: false }),
        expect.objectContaining({ name: "top-package", direct: true }),
      ]);
      const command = Bun.spawn(
        [
          process.execPath,
          "-e",
          'const loaded = await import("top-package"); if (loaded.value !== "dependency-closure") process.exit(7);',
        ],
        { cwd: scope.cwd, stdout: "pipe", stderr: "pipe" },
      );
      expect(await command.exited).toBe(0);
      expect(await verifyCommandScope(scope)).toBe(true);
    } finally {
      await workspace.close();
      await rm(repository, { force: true, recursive: true });
    }
  });

  it("stages trusted project inputs and candidates at declared paths", async () => {
    const repository = await createRepository();
    const workspace = await createRunWorkspace();
    try {
      const scope = await createCommandScope({
        workspace,
        sequence: 0,
        repositoryRoot: repository,
        limits,
        dependencyPackages: [],
        targets: [
          {
            path: "src/value.ts",
            operation: "write",
            candidateBytes: Array.from(
              new TextEncoder().encode("export const value = 2;\n"),
            ),
          },
          {
            path: "test/obsolete.test.ts",
            operation: "delete",
            candidateBytes: null,
          },
        ],
      });
      expect(scope).toBeDefined();
      if (scope === undefined) throw new Error("command scope rejected");
      expect(await readFile(join(scope.cwd, "package.json"), "utf8")).toBe(
        '{"type":"module"}\n',
      );
      expect(await readFile(join(scope.cwd, "src/value.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(
        await Bun.file(join(scope.cwd, "candidate-000000.bin")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(join(scope.cwd, "test/obsolete.test.ts")).exists(),
      ).toBe(false);
      expect(scope.receipt.targets).toEqual([
        expect.objectContaining({
          path: "src/value.ts",
          operation: "write",
        }),
        {
          path: "test/obsolete.test.ts",
          operation: "delete",
          candidateDigest: null,
        },
      ]);
      expect(await verifyCommandScope(scope)).toBe(true);
      await writeFile(join(scope.cwd, "unexpected-output.txt"), "output\n");
      expect(await verifyCommandScope(scope)).toBe(false);
      await unlink(join(scope.cwd, "unexpected-output.txt"));
      await writeFile(join(scope.cwd, "package.json"), '{"type":"commonjs"}\n');
      expect(await verifyCommandScope(scope)).toBe(false);
    } finally {
      await workspace.close();
      await rm(repository, { force: true, recursive: true });
    }
  });

  it("rejects a repository root reached through a symlink", async () => {
    const repository = await createRepository();
    const parent = await mkdtemp(join(tmpdir(), "skizzles-command-link-"));
    const linked = join(parent, "repository-link");
    await symlink(repository, linked);
    const workspace = await createRunWorkspace();
    try {
      await expect(
        createCommandScope({
          workspace,
          sequence: 0,
          repositoryRoot: linked,
          limits,
          dependencyPackages: [],
          targets: [
            {
              path: "src/value.ts",
              operation: "write",
              candidateBytes: [1],
            },
          ],
        }),
      ).resolves.toBeUndefined();
    } finally {
      await workspace.close();
      await rm(parent, { force: true, recursive: true });
      await rm(repository, { force: true, recursive: true });
    }
  });

  it("rejects a declared dependency whose package link escapes the repository boundary", async () => {
    const repository = await createRepository();
    const outside = await mkdtemp(
      join(tmpdir(), "skizzles-command-dependency-"),
    );
    await writeFile(
      join(outside, "package.json"),
      '{"name":"escaped-package","version":"1.0.0"}\n',
    );
    await mkdir(join(repository, "node_modules"));
    await symlink(outside, join(repository, "node_modules/escaped-package"));
    const workspace = await createRunWorkspace();
    try {
      await expect(
        createCommandScope({
          workspace,
          sequence: 0,
          repositoryRoot: repository,
          limits,
          dependencyPackages: ["escaped-package"],
          targets: [
            {
              path: "src/value.ts",
              operation: "write",
              candidateBytes: [1],
            },
          ],
        }),
      ).resolves.toBeUndefined();
    } finally {
      await workspace.close();
      await rm(outside, { force: true, recursive: true });
      await rm(repository, { force: true, recursive: true });
    }
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-command-repository-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "test"));
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "src/value.ts"), "export const value = 1;\n");
  await writeFile(join(root, "test/obsolete.test.ts"), "throw new Error();\n");
  return realpath(root);
}
