import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildPlugin,
  checkPlugin,
  compareTrees,
  PackagingError,
  stagePlugin,
} from "../src/plugin-package.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("deterministic plugin packaging", () => {
  test("uses the root lockfile for the Container Lab workspace", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const rootPackage = (await Bun.file(
      join(repoRoot, "package.json"),
    ).json()) as { workspaces?: unknown };
    expect(rootPackage.workspaces).toContain(
      "packages/codex-container-lab/cli",
    );
    expect(
      await Bun.file(
        join(repoRoot, "packages/codex-container-lab/cli/bun.lock"),
      ).exists(),
    ).toBe(false);
    expect(await readFile(join(repoRoot, "bun.lock"), "utf8")).toContain(
      '"codex-container-lab@workspace:packages/codex-container-lab/cli"',
    );
  });

  test("canonical hook discovery contract uses plugin-root commands", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const hooks = await Bun.file(join(repoRoot, "hooks/hooks.json")).json();

    expect(hooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: 'bun "${PLUGIN_ROOT}/hooks/manage-command-output.ts"',
                timeout: 3,
                statusMessage: "checking command output management",
              },
            ],
          },
        ],
      },
    });
  });

  test("stages only allowlisted canonical inputs deterministically", async () => {
    const root = await fixture();
    await write(
      root,
      "skills/example/SKILL.md",
      "---\nname: example\ndescription: Example skill.\n---\n",
    );
    await write(
      root,
      "hooks/hooks.json",
      JSON.stringify(
        { hooks: [{ command: "bun ${PLUGIN_ROOT}/runtime/hook.ts" }] },
        null,
        2,
      ),
    );
    await write(root, "runtime/hook.ts", "console.log('hook');\n");
    await write(root, "README.md", "must not be packaged\n");

    const first = join(root, "stage-one");
    const second = join(root, "stage-two");
    await stagePlugin(root, first);
    await stagePlugin(root, second);

    expect(await compareTrees(first, second)).toEqual([]);
    expect(await readFile(join(first, "runtime/hook.ts"), "utf8")).toBe(
      "console.log('hook');\n",
    );
    expect(
      await readFile(join(first, "packages/installer/src/cli.ts"), "utf8"),
    ).toContain("usage: bun packages/installer/src/cli.ts");
    expect(await Bun.file(join(first, "README.md")).exists()).toBe(false);
    expect(await filesUnder(join(first, "instructions"))).toEqual([
      "compact-prompt.md",
      "developer-instructions.md",
      "skizzles-base.md",
      "skizzles-base.provenance.json",
    ]);
    expect(await filesUnder(join(first, "third_party/openai-codex"))).toEqual([
      "LICENSE",
      "NOTICE",
    ]);
    expect(
      await Bun.file(
        join(first, "packages/core/prompt-layer/upstream/default.md"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(first, "packages/core/prompt-layer/skizzles-base.patch"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(first, "packages/core/prompt-layer/manifest.json"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(first, "packages/installer/src/codex-config.ts"),
      ).exists(),
    ).toBe(true);
    expect(
      await Bun.file(
        join(first, "packages/installer/src/prompt-policy.ts"),
      ).exists(),
    ).toBe(true);
  });

  test("rejects missing staged installer runtime imports while excluding test-only imports", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/installer/test/not-packaged.test.ts",
      'import "./test-helper-that-is-not-packaged.ts";\n',
    );
    await stagePlugin(root, join(root, "stage-with-test-only-import"));

    await write(
      root,
      "packages/installer/src/managed-files.ts",
      'import "./runtime-helper-that-is-not-packaged.ts";\n',
    );
    await expect(
      stagePlugin(root, join(root, "stage-with-missing-runtime-import")),
    ).rejects.toThrow("Packaged installer runtime validation failed.");
  });

  test("rejects Bun-resolved installer imports outside the staged installer root", async () => {
    const root = await fixture();
    await write(root, "runtime/outside.ts", "export const outside = true;\n");
    await write(
      root,
      "packages/installer/src/managed-files.ts",
      'import "../../../runtime/outside.ts";\n',
    );

    await expect(
      stagePlugin(root, join(root, "stage-with-escaped-installer-import")),
    ).rejects.toThrow("Packaged installer runtime validation failed.");
  });

  test("loads the staged installer CLI help contract", async () => {
    const root = await fixture();
    await stagePlugin(root, join(root, "stage-with-loadable-installer-cli"));
  });

  test("bounds a staged CLI that ignores termination and keeps output pipes open", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/installer/src/cli.ts",
      `if (import.meta.main) {
  process.on("SIGTERM", () => {});
  Bun.spawn([
    process.execPath,
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);",
  ], { stdout: "inherit", stderr: "inherit" });
  setInterval(() => {}, 1_000);
}
`,
    );

    const startedAt = performance.now();
    await expect(
      stagePlugin(root, join(root, "stage-with-hung-installer-cli")),
    ).rejects.toThrow("Packaged installer runtime validation failed.");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test("rejects every staged installer runtime extension outside .ts", async () => {
    for (const extension of ["js", "tsx", "cjs", "json"] as const) {
      const root = await fixture();
      await write(
        root,
        `packages/core/plugin-template/packages/installer/src/unsupported.${extension}`,
        "export {};\n",
      );
      await expect(
        stagePlugin(root, join(root, `stage-with-unsupported-${extension}`)),
      ).rejects.toThrow(
        `Packaged installer runtime src/unsupported.${extension} is unsupported; only TypeScript ESM .ts files may be staged.`,
      );
    }
  });

  test("rejects tampered prompt-policy content, provenance, legal input, and descriptor shape", async () => {
    for (const mutation of [
      "prompt",
      "provenance",
      "legal",
      "descriptor",
    ] as const) {
      const root = await fixture();
      if (mutation === "prompt") {
        await write(root, "instructions/skizzles-base.md", "tampered\n");
      } else if (mutation === "provenance") {
        await write(root, "instructions/skizzles-base.provenance.json", "{}\n");
      } else if (mutation === "legal") {
        await write(
          root,
          "packages/core/prompt-layer/upstream/NOTICE",
          "tampered\n",
        );
      } else {
        const path = join(root, "integrations/prompt-policy.json");
        const descriptor = JSON.parse(await readFile(path, "utf8"));
        descriptor.unexpected = true;
        await writeFile(path, `${JSON.stringify(descriptor, null, 2)}\n`);
      }
      await expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow();
    }
  });

  test("rejects non-canonical prompt-policy legal mappings before staging", async () => {
    for (const mutation of [
      "license-source",
      "notice-packaged",
      "swapped",
      "duplicate-source",
      "duplicate-packaged",
    ] as const) {
      const root = await fixture();
      const path = join(root, "integrations/prompt-policy.json");
      const descriptor = JSON.parse(await readFile(path, "utf8"));
      const legal = descriptor.base.legal;
      if (mutation === "license-source") {
        legal.license.sourcePath =
          "packages/core/prompt-layer/upstream/RENAMED-LICENSE";
      } else if (mutation === "notice-packaged") {
        legal.notice.packagedPath = "third_party/other/NOTICE";
      } else if (mutation === "swapped") {
        [legal.license.sourcePath, legal.notice.sourcePath] = [
          legal.notice.sourcePath,
          legal.license.sourcePath,
        ];
        [legal.license.packagedPath, legal.notice.packagedPath] = [
          legal.notice.packagedPath,
          legal.license.packagedPath,
        ];
      } else if (mutation === "duplicate-source") {
        legal.notice.sourcePath = legal.license.sourcePath;
      } else {
        legal.notice.packagedPath = legal.license.packagedPath;
      }
      await writeFile(path, `${JSON.stringify(descriptor, null, 2)}\n`);
      await expect(
        stagePlugin(root, join(root, "stage")),
      ).rejects.toBeInstanceOf(PackagingError);
    }
  });

  test("rejects symlinked prompt-policy inputs before staging", async () => {
    const root = await fixture();
    const prompt = join(root, "instructions/skizzles-base.md");
    await rm(prompt);
    await symlink(
      join(
        resolve(import.meta.dir, "../../.."),
        "instructions/skizzles-base.md",
      ),
      prompt,
    );
    await expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "uses a symlinked policy path",
    );

    const parentRoot = await fixture();
    await rm(join(parentRoot, "instructions"), { recursive: true });
    await symlink(
      join(resolve(import.meta.dir, "../../.."), "instructions"),
      join(parentRoot, "instructions"),
    );
    await expect(
      stagePlugin(parentRoot, join(parentRoot, "stage")),
    ).rejects.toThrow("uses a symlinked policy path");
  });

  test("check reports generated drift", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await checkPlugin(root);
    await write(root, "plugins/skizzles/unexpected.txt", "drift\n");

    expect(checkPlugin(root)).rejects.toThrow("unexpected unexpected.txt");
  });

  test("check reports generated executable-mode drift", async () => {
    const root = await fixture();
    await write(root, "runtime/executable.ts", "console.log('ok');\n");
    await chmod(join(root, "runtime/executable.ts"), 0o755);
    await buildPlugin(root);
    await chmod(join(root, "plugins/skizzles/runtime/executable.ts"), 0o644);

    expect(checkPlugin(root)).rejects.toThrow(
      "changed mode runtime/executable.ts",
    );
  });

  test("check reports drift in the bundled Container Lab runtime", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await write(
      root,
      "packages/codex-container-lab/cli/src/cli.ts",
      "#!/usr/bin/env bun\nconsole.log(JSON.stringify({ help: 'changed' }));\n",
    );

    expect(checkPlugin(root)).rejects.toThrow(
      "changed packages/codex-container-lab/cli/src/cli.ts",
    );
  });

  test("ships runnable dependency-self-contained Container Lab bundles", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "skizzles-container-lab-plugin-"),
    );
    temporaryRoots.push(temporaryRoot);
    const stagedPlugin = join(temporaryRoot, "staged");
    const isolatedPlugin = join(temporaryRoot, "isolated");
    await stagePlugin(repoRoot, stagedPlugin);
    await cp(stagedPlugin, isolatedPlugin, { recursive: true });

    const runtimeRoot = join(isolatedPlugin, "packages/codex-container-lab");
    expect(await filesUnder(runtimeRoot)).toEqual([
      "LICENSE",
      "cli/install/com.openai.codex-container-lab-reaper.plist",
      "cli/src/cli.ts",
      "cli/src/reaper-cli.ts",
      "docs/architecture.md",
      "docs/completion-contract.md",
      "docs/installation.md",
      "docs/manifest.md",
      "docs/safety.md",
    ]);

    for (const entrypoint of ["cli/src/cli.ts", "cli/src/reaper-cli.ts"]) {
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

  test("exercises bundled YAML manifest configuration with a fake Docker binary", async () => {
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
        join(plugin, "packages/codex-container-lab/cli/src/cli.ts"),
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
      labId: expect.stringMatching(/^yaml-/),
      state: "ready",
    });
  });

  test("rejects stale Container Lab descriptor metadata before staging", async () => {
    const root = await fixture();
    const descriptorPath = join(root, "integrations/container-lab.json");
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

  test("rejects stale Container Lab provenance and canonical ownership paths before staging", async () => {
    const root = await fixture();
    const descriptorPath = join(root, "integrations/container-lab.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.ownership.provenanceCommit =
      "0000000000000000000000000000000000000000";
    descriptor.ownership.canonicalSource = "packages/other-container-lab";
    await writeFile(descriptorPath, JSON.stringify(descriptor));

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs",
    );
  });

  test("rejects Finder metadata in canonical package inputs", async () => {
    const root = await fixture();
    await write(root, "skills/.DS_Store", "local metadata");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "skills/.DS_Store looks like local or live state",
    );
  });

  test("rejects Finder metadata in generated output", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await write(root, "plugins/skizzles/.DS_Store", "local metadata");

    expect(checkPlugin(root)).rejects.toThrow(
      "generated plugin contains forbidden Finder metadata at .DS_Store",
    );
  });

  test("rejects machine-specific paths in distributable output", async () => {
    const root = await fixture();
    await write(
      root,
      "runtime/config.ts",
      "export const path = '/Users/alice/.codex';\n",
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "contains machine-specific path /Users/alice/",
    );
  });

  test("rejects environment and credential artifacts", async () => {
    const root = await fixture();
    await write(root, "runtime/.env.production", "TOKEN=secret\n");
    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "looks like local or live state",
    );
  });

  test("validates creator-required manifest metadata", async () => {
    const root = await fixture();
    const manifestPath = join(
      root,
      "packages/core/plugin-template/.codex-plugin/plugin.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "not-semver";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "skizzles", version: "not-semver" }),
    );
    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "strict semver",
    );
  });

  test("rejects hooks that bypass PLUGIN_ROOT", async () => {
    const root = await fixture();
    await write(
      root,
      "hooks/hooks.json",
      JSON.stringify({ hooks: [{ command: "bun runtime/hook.ts" }] }),
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "must resolve bundled commands through ${PLUGIN_ROOT}",
    );
  });

  test("rejects live-state artifacts", async () => {
    const root = await fixture();
    await write(root, "runtime/session.sqlite", "state");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toBeInstanceOf(
      PackagingError,
    );
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-package-test-"));
  temporaryRoots.push(root);
  await write(
    root,
    "package.json",
    JSON.stringify(
      { name: "skizzles", version: "0.1.0", private: true },
      null,
      2,
    ),
  );
  await write(
    root,
    "skills/example/SKILL.md",
    "---\nname: example\ndescription: Fixture skill.\n---\n",
  );
  await write(
    root,
    "packages/core/plugin-template/.codex-plugin/plugin.json",
    JSON.stringify(
      {
        name: "skizzles",
        version: "0.1.0",
        description: "fixture",
        author: { name: "Fixture" },
        skills: "./skills/",
        interface: {
          displayName: "Skizzles",
          shortDescription: "fixture",
          longDescription: "fixture",
          developerName: "Fixture",
          category: "Developer Tools",
          capabilities: [],
          defaultPrompt: ["Use fixture"],
        },
      },
      null,
      2,
    ),
  );
  await write(
    root,
    ".agents/plugins/marketplace.json",
    JSON.stringify(
      {
        name: "skizzles",
        plugins: [
          {
            name: "skizzles",
            source: { source: "local", path: "./plugins/skizzles" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Developer Tools",
          },
        ],
      },
      null,
      2,
    ),
  );
  await write(
    root,
    "packages/codex-container-lab/cli/src/cli.ts",
    "#!/usr/bin/env bun\nif (import.meta.main) console.log(JSON.stringify({ help: 'fixture cli' }));\n",
  );
  for (const path of [
    "codex-config.ts",
    "config.ts",
    "core.ts",
    "doctor.ts",
    "harness.ts",
    "managed-files.ts",
    "prompt-policy-lock.ts",
    "prompt-policy.ts",
  ]) {
    await write(
      root,
      `packages/installer/src/${path}`,
      path === "codex-config.ts"
        ? 'export { fixture } from "./managed-files.ts";\n'
        : `export const fixture = "${path}";\n`,
    );
  }
  await write(
    root,
    "packages/installer/src/cli.ts",
    'if (import.meta.main) {\n  console.error("usage: bun packages/installer/src/cli.ts <command>");\n  process.exit(2);\n}\n',
  );
  await write(
    root,
    "packages/installer/package.json",
    JSON.stringify({ name: "@skizzles/installer", version: "0.1.0" }),
  );
  await write(
    root,
    "packages/codex-container-lab/cli/src/reaper-cli.ts",
    "#!/usr/bin/env bun\nif (import.meta.main) console.log(JSON.stringify({ help: 'fixture reaper' }));\n",
  );
  await write(
    root,
    "packages/codex-container-lab/cli/package.json",
    JSON.stringify({ name: "codex-container-lab", version: "0.1.0" }),
  );
  await write(
    root,
    "packages/codex-container-lab/cli/install/com.openai.codex-container-lab-reaper.plist",
    '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n',
  );
  await write(
    root,
    "packages/codex-container-lab/LICENSE",
    "fixture license\n",
  );
  for (const document of [
    "architecture",
    "completion-contract",
    "installation",
    "manifest",
    "safety",
  ]) {
    await write(
      root,
      `packages/codex-container-lab/docs/${document}.md`,
      `# ${document}\n`,
    );
  }
  await write(
    root,
    "skills/codex-container-lab/scripts/codex-container-lab",
    "#!/usr/bin/env bun\nconsole.log('fixture');\n",
  );
  await chmod(
    join(root, "skills/codex-container-lab/scripts/codex-container-lab"),
    0o755,
  );
  await write(
    root,
    "integrations/container-lab.json",
    JSON.stringify({
      configuredRuntime: "0.1.0",
      ownership: {
        runtimeOwner: "skizzles",
        canonicalSource: "packages/codex-container-lab",
        provenanceCommit: "a2f44416ef467d9f54b3cb228e3bd050987a3c4c",
      },
      bundled: {
        operationalEntrypoint: "packages/codex-container-lab/cli/src/cli.ts",
        reaperEntrypoint: "packages/codex-container-lab/cli/src/reaper-cli.ts",
        launcher: "skills/codex-container-lab/scripts/codex-container-lab",
        launchAgentTemplate:
          "packages/codex-container-lab/cli/install/com.openai.codex-container-lab-reaper.plist",
        documentation: [
          "packages/codex-container-lab/docs/architecture.md",
          "packages/codex-container-lab/docs/completion-contract.md",
          "packages/codex-container-lab/docs/installation.md",
          "packages/codex-container-lab/docs/manifest.md",
          "packages/codex-container-lab/docs/safety.md",
        ],
      },
    }),
  );
  const canonicalRoot = resolve(import.meta.dir, "../../..");
  for (const path of [
    "integrations/prompt-policy.json",
    "instructions/skizzles-base.md",
    "instructions/skizzles-base.provenance.json",
    "instructions/developer-instructions.md",
    "instructions/compact-prompt.md",
    "packages/core/prompt-layer/upstream/LICENSE",
    "packages/core/prompt-layer/upstream/NOTICE",
  ]) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(canonicalRoot, path), destination);
  }
  return root;
}

async function write(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relativePath);
      } else files.push(relativePath);
    }
  }
  await visit(root);
  return files.sort();
}
