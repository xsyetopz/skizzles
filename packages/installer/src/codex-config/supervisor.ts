import process from "node:process";
import type { OwnedChild } from "@skizzles/run-workspace";

const EXIT_TIMEOUT_MS = 2000;
const POLL_MS = 10;
const SOURCE = String.raw`
process.on("SIGTERM", () => undefined);
const command = JSON.parse(Bun.argv[1]);
const publish = (value) => process.send?.(value);
try {
  const tool = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  publish({ type: "ready" });
  tool.exited.then(
    (exitCode) => publish({ type: "exited", exitCode }),
    () => publish({ type: "tool-error" }),
  );
} catch {
  publish({ type: "spawn-error" });
}
setInterval(() => undefined, 2147483647);
`;

type RpcProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;
type ProtocolState =
  | "exited"
  | "pending"
  | "ready"
  | "spawn-error"
  | "tool-error";

interface RpcSupervisor {
  readonly process: RpcProcess;
  readonly scope: OwnedChild;
  waitUntilReady: () => Promise<void>;
  waitForToolExit: (timeoutMs: number) => Promise<boolean>;
}

function spawnRpcSupervisor(
  command: readonly string[],
  environment: Record<string, string | undefined>,
): RpcSupervisor {
  let state: ProtocolState = "pending";
  let protocolFailure: Error | undefined;
  let child: RpcProcess;
  child = Bun.spawn(
    [process.execPath, "--eval", SOURCE, JSON.stringify(command)],
    {
      env: environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      ipc(message) {
        const next = protocolMessage(message, state);
        if (next instanceof Error) {
          protocolFailure ??= next;
        } else {
          state = next;
        }
      },
    },
  );
  const waitFor = async (
    accepted: ReadonlySet<ProtocolState>,
    timeoutMs: number,
  ): Promise<ProtocolState | undefined> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (protocolFailure !== undefined) throw protocolFailure;
      if (accepted.has(state)) return state;
      const event = await Promise.race([
        child.exited.then(() => "exited" as const),
        Bun.sleep(POLL_MS).then(() => "pending" as const),
      ]);
      if (event === "exited")
        throw new Error("Codex app-server supervisor exited unexpectedly");
    }
    return undefined;
  };
  return {
    process: child,
    scope: supervisorScope(child),
    waitUntilReady: async () => {
      const result = await waitFor(
        new Set(["ready", "exited", "spawn-error", "tool-error"]),
        EXIT_TIMEOUT_MS,
      );
      if (result !== "ready") {
        throw new Error("Codex app-server could not start");
      }
    },
    waitForToolExit: async (timeoutMs) =>
      (await waitFor(
        new Set(["exited", "spawn-error", "tool-error"]),
        timeoutMs,
      )) === "exited",
  };
}

function protocolMessage(
  value: unknown,
  current: ProtocolState,
): ProtocolState | Error {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return new Error("Codex app-server supervisor protocol is invalid");
  }
  const keys = Object.keys(value);
  if (value.type === "ready" && keys.length === 1 && current === "pending")
    return "ready";
  if (
    value.type === "exited" &&
    keys.length === 2 &&
    "exitCode" in value &&
    Number.isSafeInteger(value.exitCode) &&
    current === "ready"
  )
    return "exited";
  if (
    (value.type === "spawn-error" || value.type === "tool-error") &&
    keys.length === 1
  )
    return value.type;
  return new Error("Codex app-server supervisor protocol is invalid");
}

function supervisorScope(child: RpcProcess): OwnedChild {
  const signal = (value: NodeJS.Signals): void => {
    signalOwnedSupervisor(child.exitCode !== null, child.pid, value);
  };
  return {
    label: "Codex app-server supervisor",
    pid: child.pid,
    requestStop: () => signal("SIGTERM"),
    forceStop: () => signal("SIGKILL"),
    waitForExit: async () => {
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(EXIT_TIMEOUT_MS).then(() => false),
      ]);
      if (!exited) throw new Error("Codex app-server supervisor did not exit");
      const deadline = Date.now() + EXIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          )
            return;
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "EPERM"
            )
          )
            throw error;
        }
        await Bun.sleep(POLL_MS);
      }
      throw new Error(
        "Codex app-server process scope exit could not be verified",
      );
    },
  };
}

function signalOwnedSupervisor(
  supervisorExited: boolean,
  pid: number,
  signal: NodeJS.Signals,
  kill: typeof process.kill = process.kill,
): boolean {
  if (supervisorExited) return false;
  try {
    kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

export { type RpcSupervisor, signalOwnedSupervisor, spawnRpcSupervisor };
