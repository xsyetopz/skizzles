// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { inspectSourceRepository } from "../../src/process/repository.ts";
import { runCommand } from "../../src/process.ts";
import { serializePublicJson } from "../../src/public/json.ts";
import type { LabMetadata } from "../../src/state/lab/contract.ts";
import { writeLab } from "../../src/state/lab/store.ts";
import { labManifestPath, ownerKey } from "../../src/state/layout.ts";
import { ensureOwner } from "../../src/state/owner-store.ts";
import { initializeSyncBaseline } from "../../src/sync/api.ts";

export const canonicalPositivePid = /^[1-9][0-9]*$/;

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
    composeEnvironment: [],
    secretEnvironment: [],
  };
}

async function oversizedPreviewFixture(
  trackTemporaryPath: (root: string) => string,
) {
  const root = trackTemporaryPath(
    await mkdtemp(join(tmpdir(), "container-lab-sync-preview-cli-")),
  );
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
  const sourceRepository = await inspectSourceRepository(
    lab.sourceRoot,
    process.env,
  );
  lab.repoHash = sourceRepository.repoHash;
  lab.sourceRepositoryIdentity = sourceRepository.identity;
  const sourceFile = join(lab.runtimeRoot, "source.compose.json");
  const overrideFile = join(lab.runtimeRoot, "override.compose.yaml");
  await writeFile(sourceFile, '{"services":{"dev":{}}}');
  await writeFile(overrideFile, "services: {}\n");
  lab.runtime = {
    config: {
      repoRoot: lab.sourceRoot,
      manifestPath: lab.manifestPath,
      mode: { kind: "image", image: "node:24", commandService: "dev" },
      runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] },
      ports: [],
      forwardEnvironment: [],
      composeEnvironment: [],
      secretEnvironment: [],
    },
    composeArgs: [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-directory",
      lab.sourceRoot,
      "--project-name",
      lab.composeProject,
      "-f",
      sourceFile,
      "-f",
      overrideFile,
    ],
    sourceFile,
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

async function attachedFixture(trackTemporaryPath: (root: string) => string) {
  const root = trackTemporaryPath(
    await mkdtemp(join(tmpdir(), "container-lab-run-cli-")),
  );
  const owner = "thread-attached-run";
  const stateRoot = join(root, "state");
  const runtimeRoot = join(root, "runtime");
  const lab = fixtureLab(root, owner);
  lab.state = "ready";
  lab.modeKind = "image";
  const sourceFile = join(lab.runtimeRoot, "source.compose.json");
  const overrideFile = join(lab.runtimeRoot, "override.compose.yaml");
  await mkdir(lab.workspace, { recursive: true });
  await mkdir(lab.sourceRoot, { recursive: true });
  await writeFile(lab.manifestPath, "image: { name: node:24, service: dev }\n");
  await writeFile(sourceFile, '{"services":{"dev":{}}}');
  await writeFile(overrideFile, "services: {}\n");
  lab.runtime = {
    config: {
      repoRoot: lab.sourceRoot,
      manifestPath: lab.manifestPath,
      mode: { kind: "image", image: "node:24", commandService: "dev" },
      runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] },
      ports: [],
      forwardEnvironment: [],
      composeEnvironment: [],
      secretEnvironment: [],
    },
    composeArgs: [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-directory",
      lab.sourceRoot,
      "--project-name",
      lab.composeProject,
      "-f",
      sourceFile,
      "-f",
      overrideFile,
    ],
    sourceFile,
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
  const testToken = `codex-container-lab-test:${randomUUID()}`;
  const leaderIdentityPath = `${pidPath}.identity.json`;
  const descendantIdentityPath = `${descendantPath}.identity.json`;
  await writeFile(
    dockerPath,
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst joined = args.join(" ");\nconst pidPath = ${JSON.stringify(pidPath)};\nconst descendantPath = ${JSON.stringify(descendantPath)};\nconst token = ${JSON.stringify(testToken)};\nconst identity = (pid) => {\n  const result = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]);\n  const processGroup = Number(result.stdout.toString().trim());\n  if (!Number.isSafeInteger(processGroup) || processGroup <= 0) throw new Error("invalid process group");\n  return JSON.stringify({ version: 1, pid, processGroup, token });\n};\nif (joined.includes("termination_result()")) {\n  let pid; try { const text = await Bun.file(pidPath).text(); if (!/^[1-9][0-9]*$/.test(text)) throw new Error("invalid PID"); pid = Number(text); if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid PID"); } catch { console.log("codex-container-lab-termination:unavailable"); process.exit(0); }\n  const signal = joined.includes("kill -INT") ? "SIGINT" : joined.includes("kill -TERM") ? "SIGTERM" : "SIGKILL";\n  try { process.kill(-pid, signal); console.log("codex-container-lab-termination:signaled"); } catch { console.log("codex-container-lab-termination:absent"); }\n  process.exit(0);\n}\nconsole.log("early-output"); console.error("early-error");\nif (process.env.BUILDKIT_PROGRESS?.startsWith("fixture-exit:")) process.exit(Number(process.env.BUILDKIT_PROGRESS.slice(13)));\nconst running = Bun.spawn(["/bin/sh", "-c", "trap 'exit 130' INT; trap 'exit 143' TERM; (trap '' INT TERM; while :; do sleep 1; done) & printf '%s\\n' $!; while :; do sleep 1; done", token], { detached: true, stdin: "ignore", stdout: "pipe", stderr: "inherit" });\nconst reader = running.stdout.getReader();\nconst published = await reader.read();\nconst descendant = Number(new TextDecoder().decode(published.value).trim());\nif (!Number.isSafeInteger(descendant) || descendant <= 0) throw new Error("invalid descendant PID");\nawait Bun.write(${JSON.stringify(leaderIdentityPath)}, identity(running.pid));\nawait Bun.write(${JSON.stringify(descendantIdentityPath)}, identity(descendant));\nawait Bun.write(pidPath, String(running.pid));\nawait Bun.write(descendantPath, String(descendant));\nconst code = await running.exited;\ntry { process.kill(-running.pid, "SIGTERM"); } catch {}\nfor (let i = 0; i < 100; i++) {\n  try { process.kill(-running.pid, 0); } catch { break; }\n  await Promise.resolve();\n}\ntry { process.kill(-running.pid, 0); process.kill(-running.pid, "SIGKILL"); } catch {}\nprocess.exit(code);\n`,
  );
  await chmod(dockerPath, 0o755);
  return {
    root,
    owner,
    stateRoot,
    runtimeRoot,
    pidPath,
    descendantPath,
    leaderIdentityPath,
    descendantIdentityPath,
    testToken,
    bin,
  };
}

function spawnRun(
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
        ...(extra["FAKE_EXIT"] === undefined
          ? {}
          : { BUILDKIT_PROGRESS: `fixture-exit:${extra["FAKE_EXIT"]}` }),
      },
    },
  );
}

type AttachedFixture = Awaited<ReturnType<typeof attachedFixture>>;
type RunProcess = ReturnType<typeof spawnRun>;

interface PublishedProcessIdentity {
  readonly version: 1;
  readonly pid: number;
  readonly processGroup: number;
  readonly token: string;
}

interface ObservedProcessIdentity {
  readonly pid: number;
  readonly processGroup: number;
  readonly command: string;
}

async function terminateProcess(child: RunProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const deadline = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => deadline.resolve(false), 500);
  const exited = await Promise.race([
    child.exited.then(() => true),
    deadline.promise,
  ]);
  clearTimeout(timer);
  if (!exited) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

function parseProcessIdentity(
  source: string,
  identityPath: string,
): PublishedProcessIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Malformed attached process identity ${identityPath}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Malformed attached process identity ${identityPath}`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "pid,processGroup,token,version" ||
    record["version"] !== 1 ||
    !Number.isSafeInteger(record["pid"]) ||
    (record["pid"] as number) <= 0 ||
    !Number.isSafeInteger(record["processGroup"]) ||
    (record["processGroup"] as number) <= 0 ||
    typeof record["token"] !== "string" ||
    record["token"].length < 32
  ) {
    throw new Error(`Malformed attached process identity ${identityPath}`);
  }
  return {
    version: 1,
    pid: record["pid"] as number,
    processGroup: record["processGroup"] as number,
    token: record["token"],
  };
}

function observeProcess(pid: number): ObservedProcessIdentity | undefined {
  let output: string;
  try {
    output = execFileSync(
      "ps",
      ["-o", "pid=", "-o", "pgid=", "-o", "command=", "-p", String(pid)],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return undefined;
  }
  const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(output);
  if (!match) {
    throw new Error(`Could not parse observed identity for PID ${pid}`);
  }
  const pidText = match[1];
  const processGroupText = match[2];
  const command = match[3];
  if (
    pidText === undefined ||
    processGroupText === undefined ||
    command === undefined
  ) {
    throw new Error(`Could not parse observed identity for PID ${pid}`);
  }
  return {
    pid: Number(pidText),
    processGroup: Number(processGroupText),
    command,
  };
}

async function validatePublishedProcess(
  pidPath: string,
  identityPath: string,
  token: string,
): Promise<
  | {
      readonly published: PublishedProcessIdentity;
      readonly observed: ObservedProcessIdentity | undefined;
    }
  | undefined
> {
  const [pidExists, identityExists] = await Promise.all([
    Bun.file(pidPath).exists(),
    Bun.file(identityPath).exists(),
  ]);
  if (!pidExists && !identityExists) {
    return undefined;
  }
  if (!pidExists || !identityExists) {
    throw new Error(`Incomplete attached process identity for ${pidPath}`);
  }
  const pid = parsePublishedPid(await readFile(pidPath, "utf8"));
  if (pid === undefined) {
    throw new Error(`Malformed attached PID marker ${pidPath}`);
  }
  const published = parseProcessIdentity(
    await readFile(identityPath, "utf8"),
    identityPath,
  );
  if (published.pid !== pid || published.token !== token) {
    throw new Error(`Mismatched attached process identity for ${pidPath}`);
  }
  const observed = observeProcess(pid);
  if (
    observed !== undefined &&
    (observed.pid !== published.pid ||
      observed.processGroup !== published.processGroup ||
      !observed.command.endsWith(token))
  ) {
    throw new Error(`Stale or reused attached process identity for ${pidPath}`);
  }
  return { published, observed };
}

function processGroupExists(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(processGroup: number): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroup)) {
      return true;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return !processGroupExists(processGroup);
}

async function validateAttachedGroup(
  fixture: AttachedFixture,
): Promise<number | undefined> {
  const [leader, descendant] = await Promise.all([
    validatePublishedProcess(
      fixture.pidPath,
      fixture.leaderIdentityPath,
      fixture.testToken,
    ),
    validatePublishedProcess(
      fixture.descendantPath,
      fixture.descendantIdentityPath,
      fixture.testToken,
    ),
  ]);
  if (leader === undefined && descendant === undefined) {
    return undefined;
  }
  if (leader === undefined || descendant === undefined) {
    throw new Error(`Incomplete attached process group for ${fixture.root}`);
  }
  if (
    leader.published.pid !== leader.published.processGroup ||
    descendant.published.processGroup !== leader.published.processGroup
  ) {
    throw new Error(`Mismatched attached process group for ${fixture.root}`);
  }
  if (leader.observed === undefined && descendant.observed === undefined) {
    if (processGroupExists(leader.published.processGroup)) {
      throw new Error(
        `Attached process group ${leader.published.processGroup} remains without an exact known identity`,
      );
    }
    return;
  }
  return leader.published.processGroup;
}

async function terminateAttachedGroup(fixture: AttachedFixture): Promise<void> {
  const processGroup = await validateAttachedGroup(fixture);
  if (processGroup === undefined) {
    return;
  }
  process.kill(-processGroup, "SIGTERM");
  if (await waitForProcessGroupExit(processGroup)) {
    return;
  }
  const revalidatedGroup = await validateAttachedGroup(fixture);
  if (revalidatedGroup === undefined) {
    if (processGroupExists(processGroup)) {
      throw new Error(
        `Attached process group ${processGroup} changed identity before SIGKILL`,
      );
    }
    return;
  }
  if (revalidatedGroup !== processGroup) {
    throw new Error(`Attached process group identity changed before SIGKILL`);
  }
  process.kill(-processGroup, "SIGKILL");
  if (!(await waitForProcessGroupExit(processGroup))) {
    throw new Error(`Attached process group ${processGroup} survived SIGKILL`);
  }
}

export function createCliFixtureScope() {
  const temporary = new Set<string>();
  const attachedFixtures = new Set<AttachedFixture>();
  const processes = new Set<RunProcess>();

  function trackTemporaryPath(root: string): string {
    temporary.add(root);
    return root;
  }

  async function createAttachedFixture(): Promise<AttachedFixture> {
    const fixture = await attachedFixture(trackTemporaryPath);
    attachedFixtures.add(fixture);
    return fixture;
  }

  function createRunProcess(
    fixture: AttachedFixture,
    extra: Record<string, string> = {},
    timeoutSeconds?: number,
  ): RunProcess {
    const child = spawnRun(fixture, extra, timeoutSeconds);
    processes.add(child);
    return child;
  }

  async function cleanup(): Promise<void> {
    for (const child of processes) {
      await terminateProcess(child);
      processes.delete(child);
    }
    for (const fixture of attachedFixtures) {
      await terminateAttachedGroup(fixture);
      attachedFixtures.delete(fixture);
    }
    for (const root of temporary) {
      await rm(root, { recursive: true, force: true });
      temporary.delete(root);
    }
  }

  return {
    attachedFixture: createAttachedFixture,
    cleanup,
    oversizedPreviewFixture: () => oversizedPreviewFixture(trackTemporaryPath),
    spawnRun: createRunProcess,
    trackTemporaryPath,
  };
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
