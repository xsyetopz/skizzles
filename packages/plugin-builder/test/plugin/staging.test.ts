import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  compareTrees,
  packagePaths,
  PackagingError,
  stagePlugin,
} from "../../src/plugin/api.ts";
import {
  createTestWorkspace,
  filesUnder,
  PLUGIN_ROOT_TOKEN,
  requiredTestArray,
  requiredTestRecord,
  requiredTestString,
  textOutput,
  write,
} from "./fixture.ts";

const { cleanup, fixture, temporaryRoot } = createTestWorkspace();
afterEach(cleanup);

describe("plugin staging and discovery", () => {
  it("discovers default workspace paths independently of source depth", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../..");
    const paths = packagePaths();
    expect(paths).toEqual({
      repoRoot,
      templateRoot: join(repoRoot, "packages/plugin-builder/template"),
      generatedRoot: join(repoRoot, "plugins/skizzles"),
      marketplacePath: join(repoRoot, ".agents/plugins/marketplace.json"),
    });

    const parent = await temporaryRoot("default-root");
    const destination = join(parent, "staged");
    await stagePlugin(paths.repoRoot, destination);
    expect(
      await Bun.file(join(destination, ".codex-plugin/plugin.json")).exists(),
    ).toBe(true);
  });

  it("uses the root lockfile for the Container Lab workspace", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../..");
    const rootPackage = (await Bun.file(
      join(repoRoot, "package.json"),
    ).json()) as { workspaces?: unknown };
    expect(rootPackage.workspaces).toContain("packages/*");
    expect(
      await Bun.file(
        join(repoRoot, "packages/container-lab/bun.lock"),
      ).exists(),
    ).toBe(false);
    expect(await readFile(join(repoRoot, "bun.lock"), "utf8")).toContain(
      '"@skizzles/container-lab@workspace:packages/container-lab"',
    );
  });

  it("canonical hook discovery contract uses plugin-root commands", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../..");
    const hooks = await Bun.file(
      join(repoRoot, "packages/command-hook/assets/hooks.json"),
    ).json();

    expect(hooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `bun "${PLUGIN_ROOT_TOKEN}/hooks/manage-command-output.ts" --plugin-root "${PLUGIN_ROOT_TOKEN}"`,
                timeout: 3,
                statusMessage: "checking command output management",
              },
            ],
          },
        ],
      },
    });
  });

  it("staged hook emits a concrete supervisor command independent of PLUGIN_ROOT", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../..");
    const parent = await temporaryRoot("hook-stage");
    const stagedRoot = join(parent, "plugin root '$(touch INJECTED); & staged");
    await stagePlugin(repoRoot, stagedRoot);

    const projectRoot = join(parent, "project");
    const directArguments = join(parent, "direct-arguments.json");
    const supervisedArguments = join(parent, "supervised-arguments.json");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "argv.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'import { writeFileSync } from "node:fs";',
        'import process from "node:process";',
        'writeFileSync(process.env["ARGV_MARKER"] ?? "", JSON.stringify(Bun.argv));',
        'test("fixture", () => expect(process.env["SHOULD_FAIL"]).not.toBe("1"));',
        "",
      ].join("\n"),
    );

    const stagedHooks: unknown = await Bun.file(
      join(stagedRoot, "hooks/hooks.json"),
    ).json();
    const hooks = requiredTestRecord(stagedHooks, "staged hooks");
    const hookGroups = requiredTestRecord(hooks["hooks"], "hook groups");
    const preToolUse = requiredTestArray(
      hookGroups["PreToolUse"],
      "PreToolUse hooks",
    );
    const hookGroup = requiredTestRecord(preToolUse[0], "hook group");
    const commands = requiredTestArray(hookGroup["hooks"], "hook commands");
    const hook = requiredTestRecord(commands[0], "hook command");
    const hookCommand = requiredTestString(hook["command"], "hook command");
    const originalCommand = "bun test argv.test.ts --bail";
    const hookEnvironment = { ...process.env, PLUGIN_ROOT: stagedRoot };
    const hookResult = Bun.spawnSync(["/bin/bash", "-c", hookCommand], {
      cwd: parent,
      env: hookEnvironment,
      stdin: new TextEncoder().encode(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_input: { cmd: originalCommand, workdir: projectRoot },
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(hookResult.exitCode).toBe(0);

    const hookOutput: unknown = JSON.parse(textOutput(hookResult.stdout));
    const output = requiredTestRecord(hookOutput, "hook output");
    const specific = requiredTestRecord(
      output["hookSpecificOutput"],
      "hook-specific output",
    );
    const updatedInput = requiredTestRecord(
      specific["updatedInput"],
      "updated input",
    );
    const rewritten = requiredTestString(updatedInput["cmd"], "updated cmd");
    expect(rewritten).not.toContain(PLUGIN_ROOT_TOKEN);
    expect(rewritten).toContain("runtime/codex-command.ts");

    const commonEnvironment = { ...process.env };
    delete commonEnvironment["PLUGIN_ROOT"];
    commonEnvironment["CODEX_COMMAND_OUTPUT_DIR"] = join(parent, "runs");
    const directEnvironment = {
      ...commonEnvironment,
      ARGV_MARKER: directArguments,
    };
    const direct = Bun.spawnSync(["/bin/bash", "-c", originalCommand], {
      cwd: projectRoot,
      env: directEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const supervisedEnvironment = {
      ...commonEnvironment,
      ARGV_MARKER: supervisedArguments,
    };
    const supervised = Bun.spawnSync(["/bin/bash", "-c", rewritten], {
      cwd: projectRoot,
      env: supervisedEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(supervised.exitCode).toBe(direct.exitCode);
    expect(await readFile(supervisedArguments, "utf8")).toBe(
      await readFile(directArguments, "utf8"),
    );
    expect(textOutput(supervised.stdout)).toContain("[codex-command] exit 0");
    expect(await Bun.file(join(parent, "INJECTED")).exists()).toBe(false);
    expect(await Bun.file(join(projectRoot, "INJECTED")).exists()).toBe(false);

    const failingDirect = Bun.spawnSync(["/bin/bash", "-c", originalCommand], {
      cwd: projectRoot,
      env: {
        ...directEnvironment,
        ARGV_MARKER: join(parent, "failing-direct-arguments.json"),
        SHOULD_FAIL: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const failingSupervised = Bun.spawnSync(["/bin/bash", "-c", rewritten], {
      cwd: projectRoot,
      env: {
        ...supervisedEnvironment,
        ARGV_MARKER: join(parent, "failing-supervised-arguments.json"),
        SHOULD_FAIL: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(failingDirect.exitCode).not.toBe(0);
    expect(failingSupervised.exitCode).toBe(failingDirect.exitCode);
  }, 20_000);

  it("plugin manifest uses the authoritative repository origin", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../..");
    const manifest = await Bun.file(
      join(
        repoRoot,
        "packages/plugin-builder/template/.codex-plugin/plugin.json",
      ),
    ).json();
    expect(manifest.homepage).toBe("https://github.com/xsyetopz/skizzles");
    expect(manifest.repository).toBe("https://github.com/xsyetopz/skizzles");
    expect(manifest.author).toEqual({ name: "Robert Sale" });
  });

  it("stages only allowlisted canonical inputs deterministically", async () => {
    const root = await fixture();
    await write(
      root,
      "skills/example/SKILL.md",
      "---\nname: example\ndescription: Example skill.\n---\n\n# Example\n",
    );
    await write(root, "skills/example/dist/build.js", "build residue\n");
    await write(root, "README.md", "must not be packaged\n");

    const first = join(root, "stage-one");
    const second = join(root, "stage-two");
    await stagePlugin(root, first);
    await stagePlugin(root, second);

    expect(await compareTrees(first, second)).toEqual([]);
    expect(
      await readFile(join(first, "runtime/codex-command.ts"), "utf8"),
    ).toContain("fixture supervisor");
    expect(
      await readFile(join(first, "runtime/model-catalog.ts"), "utf8"),
    ).toContain("fixture model catalog");
    expect(await readFile(join(first, "scripts/analyze.ts"), "utf8")).toContain(
      "fixture usage analyzer",
    );
    expect(
      await readFile(join(first, "hooks/manage-command-output.ts"), "utf8"),
    ).toContain("fixture command hook");
    expect(
      await Bun.file(join(first, "skills/example/dist/build.js")).exists(),
    ).toBe(false);
    for (const legacyPath of [
      "hooks/manage-command-output",
      "runtime/codex-command",
      "runtime/model-catalog",
      "scripts/usage-analyzer",
    ]) {
      expect(await Bun.file(join(first, legacyPath)).exists()).toBe(false);
    }
    const installer = await readFile(
      join(first, "packages/installer/src/cli.ts"),
      "utf8",
    );
    expect(installer).toContain("usage: skizzles-installer ");
    expect(installer).not.toContain("usage: bun packages/installer/src/cli.ts");
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
        join(first, "packages/prompt-layer/assets/upstream/default.md"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(first, "packages/prompt-layer/assets/skizzles-base.patch"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(first, "packages/prompt-layer/assets/manifest.json"),
      ).exists(),
    ).toBe(false);
    expect(await filesUnder(join(first, "packages/installer"))).toEqual([
      "package.json",
      "src/cli.ts",
    ]);
  });

  it("rejects template-injected prompt baselines, patches, tooling, and transaction artifacts", async () => {
    for (const path of [
      "packages/prompt-layer/assets/upstream/default.md",
      "packages/prompt-layer/assets/skizzles-base.patch",
      "packages/prompt-layer/assets/.transaction/journal.json",
      "packages/prompt-layer/src/cli.ts",
      "packages/prompt-layer/src/assets/manifest.ts",
      "packages/prompt-layer/test/nested/transaction.test.ts",
    ] as const) {
      const root = await fixture();
      await write(
        root,
        `packages/plugin-builder/template/${path}`,
        "template-injected maintainer artifact\n",
      );
      const reportedPath = path.startsWith("packages/prompt-layer/assets/")
        ? "packages/prompt-layer/assets"
        : path.startsWith("packages/prompt-layer/src/")
          ? "packages/prompt-layer/src"
          : "packages/prompt-layer/test";

      await expect(stagePlugin(root, join(root, "stage"))).rejects.toEqual(
        new PackagingError(
          `Packaged plugin contains maintainer-only prompt-layer artifact ${reportedPath}.`,
        ),
      );
    }

    const emptyDirectoryRoot = await fixture();
    await mkdir(
      join(
        emptyDirectoryRoot,
        "packages/plugin-builder/template/packages/prompt-layer/assets",
      ),
      { recursive: true },
    );
    await expect(
      stagePlugin(emptyDirectoryRoot, join(emptyDirectoryRoot, "stage")),
    ).rejects.toEqual(
      new PackagingError(
        "Packaged plugin contains maintainer-only prompt-layer artifact packages/prompt-layer/assets.",
      ),
    );
  });

  it("rejects extra files in controlled prompt and OpenAI legal roots", async () => {
    for (const injection of [
      {
        path: "instructions/unexpected.md",
        message:
          "packaged prompt instructions must contain exactly compact-prompt.md, developer-instructions.md, skizzles-base.md, skizzles-base.provenance.json.",
      },
      {
        path: "third_party/openai-codex/COPYING",
        message:
          "packaged OpenAI Codex legal directory must contain exactly LICENSE, NOTICE.",
      },
    ] as const) {
      const root = await fixture();
      await write(
        root,
        `packages/plugin-builder/template/${injection.path}`,
        "unexpected controlled-root file\n",
      );

      await expect(stagePlugin(root, join(root, "stage"))).rejects.toEqual(
        new PackagingError(injection.message),
      );
    }
  });

  it("preserves legitimate non-prompt template content", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/plugin-builder/template/docs/template-note.md",
      "# Legitimate plugin documentation\n",
    );
    const destination = join(root, "stage");

    await stagePlugin(root, destination);

    expect(
      await readFile(join(destination, "docs/template-note.md"), "utf8"),
    ).toBe("# Legitimate plugin documentation\n");
  });
});
