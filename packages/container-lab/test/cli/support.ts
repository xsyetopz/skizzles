// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { withFileLock } from "../../src/locks.ts";
import { runCommand } from "../../src/process.ts";
import { serializePublicJson } from "../../src/public/json.ts";
import type { LabMetadata } from "../../src/state/lab/contract.ts";
import { writeLab } from "../../src/state/lab/store.ts";
import { labManifestPath, ownerKey } from "../../src/state/layout.ts";
import { ensureOwner } from "../../src/state/owner-store.ts";
import { initializeSyncBaseline } from "../../src/sync/api.ts";

export const temporary: string[] = [];
export const canonicalPositivePid = /^[1-9][0-9]*$/;
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

export function fixtureLab(root: string, owner: string): LabMetadata {
  const key = ownerKey(owner);
  const runtimeRoot = join(root, "runtime", key, "lab-1");
  return {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner,
    ownerKey: key,
    // biome-ignore lint/security/noSecrets: This fixed test/schema token is not a credential.
    repoHash: "123456789abc",
    composeProject: "ccl-process",
    state: "failed",
    sourceRoot: join(root, "source"),
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(root, "source", ".codex-container-lab.yaml"),
    commandService: "dev",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    findings: [],
    secretEnvironment: [],
  };
}

export async function oversizedPreviewFixture() {
  const root = await mkdtemp(join(tmpdir(), "container-lab-sync-preview-cli-"));
  temporary.push(root);
  const owner = "thread-sync-preview";
  const stateRoot = join(root, "state");
  const runtimeRoot = join(root, "runtime");
  const lab = fixtureLab(root, owner);
  lab.state = "ready";
  lab.modeKind = "image";
  await mkdir(lab.sourceRoot, { recursive: true });
  await mkdir(lab.workspace, { recursive: true });
  for (const repository of [lab.sourceRoot, lab.workspace]) {
    execFileSync("git", ["init", "-q", repository]);
    await writeFile(
      join(repository, ".codex-container-lab.yaml"),
      "image: { name: node:24, service: dev }\n",
    );
  }
  const commonGit = execFileSync(
    "git",
    [
      "-C",
      lab.sourceRoot,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    { encoding: "utf8" },
  ).trim();
  lab.repoHash = createHash("sha256")
    .update(await realpath(commonGit))
    .digest("hex")
    .slice(0, 12);
  const baseFile = join(lab.runtimeRoot, "base.compose.yaml");
  const overrideFile = join(lab.runtimeRoot, "override.compose.yaml");
  await writeFile(baseFile, "services: {}\n");
  await writeFile(overrideFile, "services: {}\n");
  lab.runtime = {
    config: {
      repoRoot: lab.sourceRoot,
      manifestPath: lab.manifestPath,
      mode: { kind: "image", image: "node:24", commandService: "dev" },
      runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] },
      ports: [],
      forwardEnvironment: [],
      secretEnvironment: [],
    },
    composeArgs: [
      "compose",
      "--project-directory",
      lab.sourceRoot,
      "--project-name",
      lab.composeProject,
      "-f",
      baseFile,
      "-f",
      overrideFile,
    ],
    baseFile,
    overrideFile,
    findings: [],
  };
  await ensureOwner(stateRoot, owner);
  await writeLab({ stateRoot, runtimeRoot }, lab);
  await initializeSyncBaseline(
    { stateRoot: lab.runtimeRoot, labId: lab.id },
    lab.workspace,
  );
  for (let index = 0; index < 100; index++) {
    const pathname = `${String(index).padStart(3, "0")}-${"x".repeat(220)}`;
    await writeFile(join(lab.sourceRoot, pathname), "updated\n");
  }
  return { owner, stateRoot, runtimeRoot, lab };
}

export async function attachedFixture() {
  const root = await mkdtemp(join(tmpdir(), "container-lab-run-cli-"));
  temporary.push(root);
  const owner = "thread-attached-run";
  const stateRoot = join(root, "state");
  const runtimeRoot = join(root, "runtime");
  const lab = fixtureLab(root, owner);
  lab.state = "ready";
  lab.modeKind = "image";
  const baseFile = join(lab.runtimeRoot, "base.compose.yaml");
  const overrideFile = join(lab.runtimeRoot, "override.compose.yaml");
  await mkdir(lab.workspace, { recursive: true });
  await mkdir(lab.sourceRoot, { recursive: true });
  await writeFile(lab.manifestPath, "image: { name: node:24, service: dev }\n");
  await writeFile(baseFile, "services: {}\n");
  await writeFile(overrideFile, "services: {}\n");
  lab.runtime = {
    config: {
      repoRoot: lab.sourceRoot,
      manifestPath: lab.manifestPath,
      mode: { kind: "image", image: "node:24", commandService: "dev" },
      runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] },
      ports: [],
      forwardEnvironment: [],
      secretEnvironment: [],
    },
    composeArgs: [
      "compose",
      "--project-directory",
      lab.sourceRoot,
      "--project-name",
      lab.composeProject,
      "-f",
      baseFile,
      "-f",
      overrideFile,
    ],
    baseFile,
    overrideFile,
    findings: [],
  };
  await ensureOwner(stateRoot, owner);
  await writeLab({ stateRoot, runtimeRoot }, lab);
  const bin = join(root, "bin");
  await mkdir(bin);
  const dockerPath = join(bin, "docker");
  const pidPath = join(root, "run.pid");
  const descendantPath = join(root, "descendant.pid");
  await writeFile(
    dockerPath,
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst joined = args.join(" ");\nconst pidPath = process.env.FAKE_PID_FILE;\nif (joined.includes("termination_result()")) {\n  let pid; try { const text = await Bun.file(pidPath).text(); if (!/^[1-9][0-9]*$/.test(text)) throw new Error("invalid PID"); pid = Number(text); if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid PID"); } catch { console.log("codex-container-lab-termination:unavailable"); process.exit(0); }\n  const signal = joined.includes("kill -INT") ? "SIGINT" : joined.includes("kill -TERM") ? "SIGTERM" : "SIGKILL";\n  try { process.kill(-pid, signal); console.log("codex-container-lab-termination:signaled"); } catch { console.log("codex-container-lab-termination:absent"); }\n  process.exit(0);\n}\nconsole.log("early-output"); console.error("early-error");\nif (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));\nconst running = Bun.spawn(["/bin/sh", "-c", "trap 'exit 130' INT; trap 'exit 143' TERM; (trap '' INT TERM; while :; do sleep 1; done) & printf %s $! > $FAKE_DESC_FILE; while :; do sleep 1; done"], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" });\nawait Bun.write(pidPath, String(running.pid));\nconst code = await running.exited;\ntry { process.kill(-running.pid, "SIGTERM"); } catch {}\nawait Bun.sleep(100);\ntry { process.kill(-running.pid, 0); process.kill(-running.pid, "SIGKILL"); } catch {}\nfor (let i=0;i<100;i++) { try { process.kill(-running.pid, 0); await Bun.sleep(10); } catch { break; } }\nprocess.exit(code);\n`,
  );
  await chmod(dockerPath, 0o755);
  return { root, owner, stateRoot, runtimeRoot, pidPath, descendantPath, bin };
}

export function spawnRun(
  fixture: Awaited<ReturnType<typeof attachedFixture>>,
  extra: Record<string, string> = {},
  timeoutSeconds?: number,
) {
  return Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../src/cli.ts"),
      "--owner",
      fixture.owner,
      "--state-root",
      fixture.stateRoot,
      "--runtime-root",
      fixture.runtimeRoot,
      "run",
      "--lab",
      "lab-1",
      ...(timeoutSeconds === undefined
        ? []
        : ["--timeout-seconds", String(timeoutSeconds)]),
      "--",
      "echo",
      "hello",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: {
        ...process.env,
        ...extra,
        PATH: `${fixture.bin}:${process.env["PATH"] ?? ""}`,
        FAKE_PID_FILE: fixture.pidPath,
        FAKE_DESC_FILE: fixture.descendantPath,
      },
    },
  );
}

export async function drain(
  reader: import("node:stream/web").ReadableStreamDefaultReader<
    Uint8Array<ArrayBuffer>
  >,
): Promise<string> {
  let output = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return output;
    }
    output += new TextDecoder().decode(next.value);
  }
}

export function parsePublishedPid(text: string): number | undefined {
  if (text !== text.trim() || !canonicalPositivePid.test(text)) {
    return undefined;
  }
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export async function waitForPublishedPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pid = parsePublishedPid(await Bun.file(path).text());
      if (pid !== undefined) {
        return pid;
      }
    } catch {
      // The fixture has not published a PID yet.
    }
    await Bun.sleep(10);
  }
  throw new Error("fixture did not publish a valid PID");
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!processExists(pid)) {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
}

export {
  chmod,
  ensureOwner,
  execFileSync,
  initializeSyncBaseline,
  join,
  labManifestPath,
  mkdir,
  mkdtemp,
  ownerKey,
  process,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  runCommand,
  serializePublicJson,
  symlink,
  tmpdir,
  withFileLock,
  writeFile,
  writeLab,
};
