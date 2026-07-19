import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { type RunOptions, runCommand } from "../src/process.ts";

const PROCESS_EXIT_ATTEMPTS = 200;
const PROCESS_EXIT_DELAY_MS = 10;
const PROCESS_MARKER_PATTERN = /^\d+ \d+\n$/u;
const WHITESPACE = /\s+/u;
const PS_MINIMUM_FIELDS = 8;
const PS_STARTED_END = 7;
const PS_COMMAND_START = 7;

interface ProcessIdentity {
  pid: number;
  processGroup: number;
  started: string;
  command: string;
}

interface RunningFixture {
  root: string;
  marker: string;
  release: string;
  completion: ReturnType<typeof runCommand>;
}

interface ProcessFixtureScope {
  captureGroup: (marker: string) => Promise<ProcessGroupIdentity>;
  cleanup: () => Promise<void>;
  start: (script: string, options?: RunOptions) => Promise<RunningFixture>;
}

interface ProcessGroupIdentity {
  processGroup: number;
  leader: number;
  descendant: number;
}

function createProcessFixtureScope(): ProcessFixtureScope {
  const temporary = new Set<string>();
  const groups = new Map<number, ProcessIdentity[]>();

  async function start(
    script: string,
    options: RunOptions = {},
  ): Promise<RunningFixture> {
    const root = await mkdtemp(join(tmpdir(), "container-lab-process-"));
    temporary.add(root);
    const marker = join(root, "process.ids");
    const release = join(root, "release");
    return {
      root,
      marker,
      release,
      completion: runCommand(
        "/bin/sh",
        ["-c", script, `fixture-${crypto.randomUUID()}`],
        { ...options, env: fixtureEnvironment(root, marker, release) },
      ),
    };
  }

  async function captureGroup(marker: string): Promise<ProcessGroupIdentity> {
    const text = await readPublishedMarker(marker, PROCESS_EXIT_ATTEMPTS);
    if (!PROCESS_MARKER_PATTERN.test(text)) {
      throw new Error(`process fixture did not publish identities: ${marker}`);
    }
    const [leaderText, descendantText] = text.trim().split(" ");
    const leader = Number(leaderText);
    const descendant = Number(descendantText);
    const identities = [
      observeProcess(leader),
      observeProcess(descendant),
    ].filter((identity): identity is ProcessIdentity => identity !== undefined);
    groups.set(leader, identities);
    return { processGroup: leader, leader, descendant };
  }

  async function cleanup(): Promise<void> {
    const failures = (
      await Promise.all([...groups].map(cleanupFixtureGroup))
    ).filter((failure): failure is Error => failure !== undefined);
    groups.clear();
    await Promise.all(
      [...temporary].map(async (root) => {
        await rm(root, { recursive: true, force: true });
      }),
    );
    temporary.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, "process fixture cleanup failed");
    }
  }

  return { captureGroup, cleanup, start };
}

function fixtureEnvironment(
  root: string,
  marker: string,
  release: string,
): NodeJS.ProcessEnv {
  return Object.fromEntries([
    ["PATH", Bun.env["PATH"]],
    ["TMPDIR", root],
    ["TEST_PROCESS_MARKER", marker],
    ["TEST_PROCESS_RELEASE", release],
  ]);
}

async function cleanupFixtureGroup([processGroup, identities]: [
  number,
  ProcessIdentity[],
]): Promise<Error | undefined> {
  if (!identities.some(matchesObservedProcess)) {
    if (processGroupExists(processGroup)) {
      return new Error(
        `fixture group ${processGroup} remains without an exact identity`,
      );
    }
    return;
  }
  try {
    process.kill(-processGroup, "SIGKILL");
    if (!(await waitForGroupExit(processGroup))) {
      return new Error(`fixture group ${processGroup} survived SIGKILL`);
    }
  } catch (error) {
    if (processGroupExists(processGroup)) {
      return asError(error);
    }
  }
  // biome-ignore lint/complexity/noUselessReturn: TypeScript's noImplicitReturns requires the explicit undefined outcome.
  return;
}

function stubbornGroupScript(afterRelease = "wait"): string {
  return [
    "trap '' TERM",
    `(/bin/sh -c 'trap "" TERM; while :; do sleep 1; done' "$0-descendant") & descendant=$!`,
    'printf "%s %s\\n" "$$" "$descendant" > "$TEST_PROCESS_MARKER"',
    '[ "$TEST_PROCESS_RELEASE" ] && while [ ! -e "$TEST_PROCESS_RELEASE" ]; do sleep 0.01; done',
    afterRelease,
  ].join("; ");
}

async function observeGroupAbsence(
  identity: ProcessGroupIdentity,
): Promise<[boolean, boolean, boolean]> {
  return [
    await waitForGroupExit(identity.processGroup),
    !processExists(identity.leader),
    !processExists(identity.descendant),
  ];
}

function observeProcess(pid: number): ProcessIdentity | undefined {
  const result = spawnSync("ps", [
    "-o",
    "pid=,pgid=,lstart=,command=",
    "-p",
    String(pid),
  ]);
  const fields = result.stdout.toString().trim().split(WHITESPACE);
  if (result.status !== 0 || fields.length < PS_MINIMUM_FIELDS) {
    return;
  }
  return {
    pid: Number(fields[0]),
    processGroup: Number(fields[1]),
    started: fields.slice(2, PS_STARTED_END).join(" "),
    command: fields.slice(PS_COMMAND_START).join(" "),
  };
}

function matchesObservedProcess(expected: ProcessIdentity): boolean {
  const observed = observeProcess(expected.pid);
  return (
    observed !== undefined &&
    observed.processGroup === expected.processGroup &&
    observed.started === expected.started &&
    observed.command === expected.command
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupExists(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGroupExit(processGroup: number): Promise<boolean> {
  return await waitForGroupExitAttempts(processGroup, PROCESS_EXIT_ATTEMPTS);
}

async function waitForGroupExitAttempts(
  processGroup: number,
  attempts: number,
): Promise<boolean> {
  if (!processGroupExists(processGroup) || attempts <= 0) {
    return !processGroupExists(processGroup);
  }
  await Bun.sleep(PROCESS_EXIT_DELAY_MS);
  return await waitForGroupExitAttempts(processGroup, attempts - 1);
}

async function readPublishedMarker(
  marker: string,
  attempts: number,
): Promise<string> {
  try {
    return await Bun.file(marker).text();
  } catch (error) {
    if (attempts <= 0) {
      throw error;
    }
    await Bun.sleep(PROCESS_EXIT_DELAY_MS);
    return await readPublishedMarker(marker, attempts - 1);
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export { createProcessFixtureScope, observeGroupAbsence, stubbornGroupScript };
