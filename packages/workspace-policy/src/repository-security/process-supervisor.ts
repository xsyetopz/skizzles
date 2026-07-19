import { readFile } from "node:fs/promises";
import process from "node:process";
import type { OwnedChild } from "@skizzles/run-workspace";

const GROUP_EXIT_TIMEOUT_MS = 2000;
const GROUP_POLL_MS = 10;
const PROTOCOL_POLL_MS = 5;
const MAXIMUM_PROTOCOL_BYTES = 128;
const SUPERVISOR_EXIT_TIMEOUT_MS = 2000;

const SUPERVISOR_SOURCE = String.raw`
const { rename, writeFile } = await import("node:fs/promises");
process.on("SIGTERM", () => undefined);
const command = JSON.parse(Bun.argv[1] ?? "null");
const status = Bun.argv[2];
const temporary = status + ".tmp";
const publish = async (message) => {
  await writeFile(temporary, JSON.stringify(message) + "\n", { mode: 0o600 });
  await rename(temporary, status);
};
try {
  const tool = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  await publish({ type: "ready" });
  tool.exited.then(
    (exitCode) => publish({ type: "exited", exitCode }),
    () => publish({ type: "tool-error" }),
  );
} catch {
  await publish({ type: "spawn-error" });
}
setInterval(() => undefined, 2147483647);
`;

type SupervisorSubprocess = Bun.Subprocess<"ignore", "pipe", "pipe">;

export type SupervisorOutcome =
  | { readonly type: "exited"; readonly exitCode: number }
  | { readonly type: "spawn-error" }
  | { readonly type: "tool-error" };

export interface CommandSupervisor {
  readonly process: SupervisorSubprocess;
  readonly child: OwnedChild;
  readonly outcome: Promise<SupervisorOutcome>;
  confirmExit: () => void;
  stop: (signal: "SIGKILL" | "SIGTERM") => boolean;
}

export interface SupervisorSpawnOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly label: string;
  readonly statusPath: string;
}

export function spawnCommandSupervisor(
  command: readonly string[],
  options: SupervisorSpawnOptions,
): CommandSupervisor {
  const subprocess = Bun.spawn(
    [
      process.execPath,
      "--eval",
      SUPERVISOR_SOURCE,
      JSON.stringify(command),
      options.statusPath,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    },
  );
  subprocess.exited.catch(() => undefined);
  const outcome = awaitSupervisorOutcome(
    subprocess,
    options.statusPath,
    options.label,
  );

  let confirmed = false;
  const stop = (signal: "SIGKILL" | "SIGTERM"): boolean =>
    signalOwnedSupervisor(subprocess.exitCode !== null, subprocess.pid, signal);
  const child: OwnedChild = {
    label: options.label,
    pid: subprocess.pid,
    requestStop: () => {
      if (!confirmed) stop("SIGTERM");
    },
    forceStop: () => {
      if (!confirmed) stop("SIGKILL");
    },
    waitForExit: async () => {
      if (confirmed) return;
      if (
        !(await settlesWithin(subprocess.exited, SUPERVISOR_EXIT_TIMEOUT_MS))
      ) {
        throw new Error(
          `${options.label} supervisor exit could not be verified`,
        );
      }
      await requireGroupAbsent(subprocess.pid, options.label);
    },
  };
  return {
    process: subprocess,
    child,
    outcome,
    confirmExit: () => {
      confirmed = true;
    },
    stop,
  };
}

async function settlesWithin(
  settled: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
  });
  try {
    return await Promise.race([settled.then(() => true as const), elapsed]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function signalOwnedSupervisor(
  supervisorExited: boolean,
  pid: number,
  signal: "SIGKILL" | "SIGTERM",
  kill: typeof process.kill = process.kill,
): boolean {
  if (supervisorExited) return false;
  try {
    kill(-pid, signal);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    throw new Error("owned supervisor group signal failed", { cause: error });
  }
}

async function requireGroupAbsent(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + GROUP_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!groupPresent(pid)) return;
    await Bun.sleep(GROUP_POLL_MS);
  }
  throw new Error(`${label} process-group cleanup could not be verified`);
}

function groupPresent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    if (isPermissionDenied(error)) return true;
    throw new Error("owned supervisor group probe failed", { cause: error });
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}

async function awaitSupervisorOutcome(
  supervisor: SupervisorSubprocess,
  statusPath: string,
  label: string,
): Promise<SupervisorOutcome> {
  while (true) {
    const status = await readProtocol(statusPath, label);
    if (status !== undefined && status.type !== "ready") return status;
    const state = await Promise.race([
      supervisor.exited.then(() => "exited" as const),
      Bun.sleep(PROTOCOL_POLL_MS).then(() => "pending" as const),
    ]);
    if (state === "exited") break;
  }
  throw new Error(`${label} supervisor exited before reporting status`);
}

async function readProtocol(
  statusPath: string,
  label: string,
): Promise<SupervisorOutcome | { readonly type: "ready" } | undefined> {
  let contents: string;
  try {
    contents = await readFile(statusPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw new Error(`${label} supervisor protocol failed`, { cause: error });
  }
  if (Buffer.byteLength(contents) > MAXIMUM_PROTOCOL_BYTES) {
    throw new Error(`${label} supervisor protocol failed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} supervisor protocol failed`, { cause: error });
  }
  if (
    !isSupervisorMessage(parsed) ||
    `${JSON.stringify(parsed)}\n` !== contents
  ) {
    throw new Error(`${label} supervisor protocol failed`);
  }
  return parsed;
}

function isSupervisorMessage(
  value: unknown,
): value is SupervisorOutcome | { readonly type: "ready" } {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  if (
    value.type === "ready" ||
    value.type === "spawn-error" ||
    value.type === "tool-error"
  ) {
    return Object.keys(value).length === 1;
  }
  return (
    value.type === "exited" &&
    "exitCode" in value &&
    typeof value.exitCode === "number" &&
    Number.isSafeInteger(value.exitCode) &&
    Object.keys(value).length === 2
  );
}
