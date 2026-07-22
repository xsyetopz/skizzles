import { afterEach, expect, it } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  applySync,
  initializeSyncBaseline,
  previewSync,
} from "../../src/sync/api.ts";
import { eligibleGitPaths } from "../../src/sync/git-manifest.ts";
import { createSyncFixtureScope, execFileSync, mkdtemp } from "./support.ts";

const fixtures = createSyncFixtureScope();
const { repo, trackTemporaryPath } = fixtures;
afterEach(fixtures.cleanup);

const forbiddenEnvironment = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_CREDENTIAL_HELPER",
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

it("Git manifest discovery strips ambient controls and disables repository executable config", async () => {
  const root = await repo("container-lab-git-environment-");
  await writeFile(path.join(root, "tracked.txt"), "tracked\n");
  await writeFile(path.join(root, "untracked.txt"), "untracked\n");
  execFileSync("git", ["-C", root, "add", "tracked.txt"]);

  const executableRoot = trackTemporaryPath(
    await mkdtemp(path.join(os.tmpdir(), "container-lab-git-executable-")),
  );
  const fsmonitorSentinel = path.join(executableRoot, "fsmonitor-ran");
  const fsmonitor = path.join(executableRoot, "fsmonitor");
  await writeFile(
    fsmonitor,
    `#!/bin/sh\nprintf ran > ${shellQuote(fsmonitorSentinel)}\n`,
  );
  await chmod(fsmonitor, 0o755);
  execFileSync("git", ["-C", root, "config", "core.fsmonitor", fsmonitor]);

  const shimRoot = trackTemporaryPath(
    await mkdtemp(path.join(os.tmpdir(), "container-lab-git-shim-")),
  );
  const capturedEnvironment = path.join(shimRoot, "environment.txt");
  const capturedArguments = path.join(shimRoot, "arguments.txt");
  const realGit = Bun.which("git");
  if (!realGit) {
    throw new Error("Git executable is unavailable");
  }
  const observedNames = [
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_TERMINAL_PROMPT",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    ...forbiddenEnvironment,
  ];
  const captureLines = observedNames
    .map((name) => {
      const present = `\${${name}+present}`;
      const value = `\${${name}-}`;
      return `if test "${present}" = present; then printf '%s=%s\\n' ${shellQuote(
        name,
      )} "${value}"; fi`;
    })
    .join("\n");
  const gitShim = path.join(shimRoot, "git");
  await writeFile(
    gitShim,
    `#!/bin/sh\n{\n${captureLines}\n} > ${shellQuote(
      capturedEnvironment,
    )}\nprintf '%s\\n' "$@" > ${shellQuote(capturedArguments)}\nexec ${shellQuote(
      realGit,
    )} "$@"\n`,
  );
  await chmod(gitShim, 0o755);

  const ambient = Object.fromEntries(
    forbiddenEnvironment.map((name) => [name, `/attacker/${name}`]),
  );
  const paths = await eligibleGitPaths(root, {
    PATH: shimRoot,
    TMPDIR: shimRoot,
    HOME: "/attacker/home",
    ...ambient,
  });

  expect(paths).toEqual(["tracked.txt", "untracked.txt"]);
  expect(await readFile(capturedEnvironment, "utf8")).toBe(
    [
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_TERMINAL_PROMPT=0",
      "LANG=C",
      "LC_ALL=C",
      `PATH=${shimRoot}`,
      `TMPDIR=${shimRoot}`,
      "",
    ].join("\n"),
  );
  expect(
    (await readFile(capturedArguments, "utf8")).trim().split("\n").slice(0, 4),
  ).toEqual(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);
  await expect(readFile(fsmonitorSentinel, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("baseline, preview, and apply use the injected service environment", async () => {
  const source = await repo("container-lab-git-source-");
  const target = await repo("container-lab-git-target-");
  for (const root of [source, target]) {
    await writeFile(path.join(root, "file.txt"), "base\n");
    execFileSync("git", ["-C", root, "add", "file.txt"]);
  }
  const stateRoot = trackTemporaryPath(
    await mkdtemp(path.join(os.tmpdir(), "container-lab-git-state-")),
  );
  const shimRoot = trackTemporaryPath(
    await mkdtemp(path.join(os.tmpdir(), "container-lab-git-service-")),
  );
  const invocations = path.join(shimRoot, "invocations.txt");
  const realGit = Bun.which("git");
  if (!realGit) {
    throw new Error("Git executable is unavailable");
  }
  const gitShim = path.join(shimRoot, "git");
  await writeFile(
    gitShim,
    `#!/bin/sh\nprintf 'invocation\\n' >> ${shellQuote(invocations)}\nexec ${shellQuote(
      realGit,
    )} "$@"\n`,
  );
  await chmod(gitShim, 0o755);
  const identity = {
    stateRoot,
    labId: "lab-service-environment",
    environment: { PATH: shimRoot, TMPDIR: shimRoot },
  };

  await initializeSyncBaseline(identity, target);
  await writeFile(path.join(source, "file.txt"), "updated\n");
  const preview = await previewSync({
    ...identity,
    direction: "push",
    sourceRoot: source,
    targetRoot: target,
  });
  await applySync({
    ...identity,
    direction: "push",
    sourceRoot: source,
    targetRoot: target,
    token: preview.token,
    idleGuard: () => true,
  });

  expect(await readFile(path.join(target, "file.txt"), "utf8")).toBe(
    "updated\n",
  );
  expect((await readFile(invocations, "utf8")).trim().split("\n")).toHaveLength(
    7,
  );
});

it("Git discovery rejects a complete NUL-terminated prefix followed by overflow", async () => {
  const root = await repo("container-lab-git-overflow-");
  const shimRoot = trackTemporaryPath(
    await mkdtemp(path.join(os.tmpdir(), "container-lab-git-overflow-shim-")),
  );
  const gitShim = path.join(shimRoot, "git");
  const fullPathCount = 17_202;
  const fullPathBytes = 3900;
  const boundaryPathBytes = 3861;
  const outputLimit = 64 * 1024 * 1024;
  expect(fullPathCount * (fullPathBytes + 1) + boundaryPathBytes + 1).toBe(
    outputLimit,
  );
  await writeFile(
    gitShim,
    `#!${process.execPath}\nconst write = async (value) => {\n  if (!process.stdout.write(value)) await new Promise((resolve) => process.stdout.once("drain", resolve));\n};\nfor (let index = 0; index < ${fullPathCount}; index++) {\n  await write(String(index).padStart(5, "0") + "a".repeat(${
      fullPathBytes - 5
    }) + "\\0");\n}\nawait write("z".repeat(${boundaryPathBytes}) + "\\0");\nawait write("tail-entry\\0");\nawait Bun.sleep(30_000);\n`,
  );
  await chmod(gitShim, 0o755);

  await expect(
    eligibleGitPaths(root, { PATH: shimRoot, TMPDIR: shimRoot }),
  ).rejects.toThrow(`git stdout exceeded ${outputLimit} byte output limit`);
});
