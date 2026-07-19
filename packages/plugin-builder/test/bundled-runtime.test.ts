// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  buildPlugin,
  checkPlugin,
  PackagingError,
  stagePlugin,
} from "../src/plugin/api.ts";
import {
  CLI_SMOKE_OUTPUT_LIMIT_BYTES,
  CLI_SMOKE_TIMEOUT_MS,
  createTestWorkspace,
  EXTERNAL_ZOD_IMPORT,
  filesUnder,
  MODEL_CATALOG_USAGE,
  write,
  YAML_LAB_ID,
} from "./plugin/fixture.ts";

const { cleanup, fixture, temporaryRoots } = createTestWorkspace();
afterEach(cleanup);

describe("generated plugin runtime bundles", () => {
  it("check reports generated drift", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await checkPlugin(root);
    await write(root, "plugins/skizzles/unexpected.txt", "drift\n");

    expect(checkPlugin(root)).rejects.toThrow("unexpected unexpected.txt");
  });

  it("check reports generated executable-mode drift", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/plugin-builder/template/runtime/executable.ts",
      "console.log('ok');\n",
    );
    await chmod(
      join(root, "packages/plugin-builder/template/runtime/executable.ts"),
      0o755,
    );
    await buildPlugin(root);
    await chmod(join(root, "plugins/skizzles/runtime/executable.ts"), 0o644);

    expect(checkPlugin(root)).rejects.toThrow(
      "changed mode runtime/executable.ts",
    );
  });

  it("check reports drift in the bundled Container Lab runtime", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await write(
      root,
      "packages/container-lab/src/cli.ts",
      "#!/usr/bin/env bun\nconsole.log(JSON.stringify({ help: 'changed' }));\n",
    );

    expect(checkPlugin(root)).rejects.toThrow(
      "changed packages/container-lab/src/cli.ts",
    );
  });

  it("ships runnable dependency-self-contained Container Lab bundles", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "skizzles-container-lab-plugin-"),
    );
    temporaryRoots.push(temporaryRoot);
    const stagedPlugin = join(temporaryRoot, "staged");
    const isolatedPlugin = join(temporaryRoot, "isolated");
    await stagePlugin(repoRoot, stagedPlugin);
    await cp(stagedPlugin, isolatedPlugin, { recursive: true });

    const runtimeRoot = join(isolatedPlugin, "packages/container-lab");
    expect(await filesUnder(runtimeRoot)).toEqual([
      "LICENSE",
      "docs/architecture.md",
      "docs/completion-contract.md",
      "docs/installation.md",
      "docs/manifest.md",
      "docs/safety.md",
      "install/com.openai.codex-container-lab-reaper.plist",
      "src/cli.ts",
      "src/reaper-cli.ts",
    ]);

    for (const entrypoint of ["src/cli.ts", "src/reaper-cli.ts"]) {
      const path = join(runtimeRoot, entrypoint);
      expect((await stat(path)).mode & 0o111).not.toBe(0);
      const result = Bun.spawnSync(["bun", path, "--help"], {
        cwd: isolatedPlugin,
        env: { PATH: process.env["PATH"] ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout.toString()) as {
        help?: unknown;
      };
      expect(typeof response.help).toBe("string");
      expect(result.stderr.toString()).toBe("");
    }
  });

  it("bundles executable workspace packages at only stable public entrypoints", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "skizzles-workspace-bundles-"),
    );
    temporaryRoots.push(temporaryRoot);
    const stagedPlugin = join(temporaryRoot, "staged");
    await stagePlugin(repoRoot, stagedPlugin);

    for (const path of [
      "hooks/manage-command-output.ts",
      "runtime/codex-command.ts",
      "runtime/model-catalog.ts",
      "scripts/analyze.ts",
      "packages/installer/src/cli.ts",
    ]) {
      const contents = await readFile(join(stagedPlugin, path), "utf8");
      expect(contents.length).toBeGreaterThan(0);
      expect(contents).not.toMatch(EXTERNAL_ZOD_IMPORT);
    }
    for (const path of [
      "hooks/manage-command-output",
      "runtime/codex-command",
      "runtime/model-catalog",
      "scripts/usage-analyzer",
    ]) {
      expect(await Bun.file(join(stagedPlugin, path)).exists()).toBe(false);
    }
    expect(await filesUnder(join(stagedPlugin, "packages/installer"))).toEqual([
      "package.json",
      "src/cli.ts",
    ]);
  });

  it("initializes the bundled Model Catalog and reaches its CLI usage contract", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "skizzles-model-catalog-bundle-"),
    );
    temporaryRoots.push(temporaryRoot);
    const stagedPlugin = join(temporaryRoot, "plugin");
    await stagePlugin(repoRoot, stagedPlugin);

    const result = Bun.spawnSync(
      [process.execPath, join(stagedPlugin, "runtime/model-catalog.ts")],
      {
        cwd: stagedPlugin,
        env: { PATH: process.env["PATH"] ?? "" },
        killSignal: "SIGKILL",
        maxBuffer: CLI_SMOKE_OUTPUT_LIMIT_BYTES,
        stderr: "pipe",
        stdout: "pipe",
        timeout: CLI_SMOKE_TIMEOUT_MS,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(`${MODEL_CATALOG_USAGE}\n`);
  });

  it("exercises bundled YAML manifest configuration with a fake Docker binary", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const root = await mkdtemp(
      join(tmpdir(), "skizzles-container-lab-bundle-config-"),
    );
    temporaryRoots.push(root);
    const plugin = join(root, "plugin");
    const source = join(root, "source");
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    const bin = join(root, "bin");
    await stagePlugin(repoRoot, plugin);
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes("config")) console.log(JSON.stringify({ services: { lab: { image: "ubuntu:24.04" } } }));\nprocess.exit(0);\n`,
    );
    await chmod(join(bin, "docker"), 0o755);
    await mkdir(source);
    await writeFile(
      join(source, ".codex-container-lab.yaml"),
      "image: { name: ubuntu:24.04, service: lab }\nruntime: { workspace: /workspace, shell: [/bin/sh, -lc] }\n",
    );
    Bun.spawnSync(["git", "init", "-q", source]);
    Bun.spawnSync(["git", "-C", source, "add", "."]);
    Bun.spawnSync([
      "git",
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);

    const result = Bun.spawnSync(
      [
        "bun",
        join(plugin, "packages/container-lab/src/cli.ts"),
        "--owner",
        "bundle-yaml",
        "--state-root",
        stateRoot,
        "--runtime-root",
        runtimeRoot,
        "lab",
        "create",
        "--name",
        "yaml",
        "--source",
        source,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const response = JSON.parse(result.stdout.toString()) as {
      labId: string;
      state: string;
    };
    if (response.state !== "ready") {
      const stateFiles = await filesUnder(stateRoot);
      const state = await Promise.all(
        stateFiles.map(
          async (path) =>
            `${path}: ${await readFile(join(stateRoot, path), "utf8")}`,
        ),
      );
      throw new Error(
        `bundled configuration fixture failed: ${state.join("\\n")}`,
      );
    }
    expect(response).toMatchObject({
      labId: expect.stringMatching(YAML_LAB_ID),
      state: "ready",
    });
  });

  it("rejects stale Container Lab descriptor metadata before staging", async () => {
    const root = await fixture();
    const descriptorPath = join(
      root,
      "packages/container-lab/assets/integrations/container-lab.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.configuredRuntime = "9.9.9";
    await writeFile(descriptorPath, JSON.stringify(descriptor));

    await expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs",
    );
    await expect(
      stagePlugin(root, join(root, "stage-error-type")),
    ).rejects.toBeInstanceOf(PackagingError);
  });

  it("rejects stale Container Lab provenance and canonical ownership paths before staging", async () => {
    const root = await fixture();
    const descriptorPath = join(
      root,
      "packages/container-lab/assets/integrations/container-lab.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.ownership.provenanceCommit =
      "0000000000000000000000000000000000000000";
    descriptor.ownership.canonicalSource = "packages/other-container-lab";
    await writeFile(descriptorPath, JSON.stringify(descriptor));

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs",
    );
  });
});
