import process from "node:process";

const FORCE_EXIT_TIMEOUT_MS = 2000;

const WORKER_SOURCE: string = `
const specification = JSON.parse(Bun.argv[1]);
const publish = (message) => {
  try {
    process.send?.(message);
  } catch {}
};
try {
  const tool = Bun.spawn([specification.command, ...specification.args], {
    cwd: specification.cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  publish({ type: "ready" });
  tool.exited.then(
    (exitCode) => publish({ type: "exited", exitCode }),
    () => publish({ type: "tool-error" }),
  );
} catch {
  publish({ type: "spawn-error" });
}
`;

const GUARDIAN_SOURCE: string = `
const workerSource = ${JSON.stringify(WORKER_SOURCE)};
const specification = Bun.argv[1];
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 2_147_483_647);
const publish = (message) => {
  try {
    process.send?.(message);
  } catch {}
};
let state = "pending";
let final = false;
try {
  const worker = Bun.spawn([process.execPath, "--eval", workerSource, specification], {
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    ipc(message) {
      if (final) return;
      const keys = typeof message === "object" && message !== null ? Object.keys(message) : [];
      if (message?.type === "ready" && keys.length === 1 && state === "pending") {
        state = "ready";
        publish(message);
        return;
      }
      if (message?.type === "spawn-error" && keys.length === 1 && state === "pending") {
        final = true;
        publish(message);
        return;
      }
      if (message?.type === "tool-error" && keys.length === 1 && state === "ready") {
        final = true;
        publish(message);
        return;
      }
      if (
        message?.type === "exited" &&
        keys.length === 2 &&
        Number.isSafeInteger(message.exitCode) &&
        state === "ready"
      ) {
        final = true;
        publish(message);
        return;
      }
      final = true;
      publish({ type: "worker-error" });
    },
  });
  worker.exited.then(
    () => {
      if (final) return;
      final = true;
      publish({ type: "worker-error" });
    },
    () => {
      if (final) return;
      final = true;
      publish({ type: "worker-error" });
    },
  );
} catch {
  final = true;
  publish({ type: "worker-error" });
}
`;

type GuardianSubprocess = Bun.Subprocess<"ignore", "pipe", "pipe">;

type ProtocolMessage =
  | { readonly type: "ready" }
  | { readonly type: "spawn-error" | "tool-error" | "worker-error" }
  | { readonly exitCode: number; readonly type: "exited" };

type FinalProtocolMessage = Exclude<
  ProtocolMessage,
  { readonly type: "ready" }
>;

interface CommandGuardian {
  readonly child: GuardianSubprocess;
  readonly final: Promise<FinalProtocolMessage>;
  forceStop: () => void;
  requestStop: () => void;
  waitForExit: () => Promise<void>;
}

interface GuardianOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function spawnCommandGuardian(
  command: string,
  args: readonly string[],
  options: GuardianOptions,
): CommandGuardian {
  const protocol = protocolReceiver();
  const specification = JSON.stringify({
    command,
    args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const child = Bun.spawn(
    [process.execPath, "--eval", GUARDIAN_SOURCE, specification],
    {
      detached: true,
      ...(options.env === undefined ? {} : { env: options.env }),
      ipc: protocol.receive,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    },
  );
  let forced = false;
  let confirmed = false;
  const signal = (value: NodeJS.Signals): boolean => {
    if (confirmed) return false;
    const sent = signalOwnedGuardian(child.exitCode !== null, child.pid, value);
    if (sent && value === "SIGKILL") forced = true;
    return sent;
  };
  return {
    child,
    final: protocol.final,
    requestStop: (): void => {
      signal("SIGTERM");
    },
    forceStop: (): void => {
      signal("SIGKILL");
    },
    waitForExit: async (): Promise<void> => {
      if (confirmed) return;
      if (!(await exitsWithin(child.exited, FORCE_EXIT_TIMEOUT_MS))) {
        throw cleanupError(command, "guardian did not exit after SIGKILL");
      }
      if (!forced) {
        throw cleanupError(
          command,
          "guardian exited before process-group termination was confirmed",
        );
      }
      confirmed = true;
    },
  };
}

async function stopCommandGuardian(
  guardian: CommandGuardian,
  command: string,
  graceMs: number,
): Promise<void> {
  let gracefulFailure: unknown;
  try {
    guardian.requestStop();
  } catch (error) {
    gracefulFailure = error;
  }
  if (!(await exitsWithin(guardian.child.exited, graceMs))) {
    try {
      guardian.forceStop();
    } catch (error) {
      const forceFailure = cleanupError(
        command,
        `cannot send SIGKILL: ${asError(error).message}`,
        error,
      );
      throw gracefulFailure === undefined
        ? forceFailure
        : new AggregateError(
            [forceFailure, gracefulFailure],
            `${command} graceful and forced cleanup both failed`,
          );
    }
  }
  try {
    await guardian.waitForExit();
  } catch (error) {
    if (gracefulFailure === undefined) throw error;
    throw new AggregateError(
      [error, gracefulFailure],
      `${command} cleanup and graceful termination both failed`,
    );
  }
  if (gracefulFailure !== undefined) throw gracefulFailure;
}

async function finishCommandGuardian(
  guardian: CommandGuardian,
  command: string,
): Promise<void> {
  try {
    guardian.forceStop();
  } catch (error) {
    throw cleanupError(
      command,
      `cannot send SIGKILL: ${asError(error).message}`,
      error,
    );
  }
  await guardian.waitForExit();
}

function protocolReceiver(): {
  readonly final: Promise<FinalProtocolMessage>;
  readonly receive: (message: unknown) => void;
} {
  const final = Promise.withResolvers<FinalProtocolMessage>();
  let state: "final" | "pending" | "ready" = "pending";
  const receive = (message: unknown): void => {
    if (state === "final") return;
    const parsed = protocolMessage(message, state);
    if (parsed instanceof Error) {
      state = "final";
      final.reject(parsed);
      return;
    }
    if (parsed.type === "ready") {
      state = "ready";
      return;
    }
    state = "final";
    final.resolve(parsed);
  };
  return { final: final.promise, receive };
}

function protocolMessage(
  value: unknown,
  state: "pending" | "ready",
): ProtocolMessage | Error {
  if (!isProtocolMessage(value)) return new Error("invalid guardian protocol");
  if (value.type === "ready") {
    return state === "pending" ? value : new Error("invalid guardian protocol");
  }
  if (value.type === "spawn-error") {
    return state === "pending" ? value : new Error("invalid guardian protocol");
  }
  if (value.type === "worker-error") return value;
  return state === "ready" ? value : new Error("invalid guardian protocol");
}

function isProtocolMessage(value: unknown): value is ProtocolMessage {
  if (!isRecord(value) || typeof value["type"] !== "string") return false;
  if (
    value["type"] === "ready" ||
    value["type"] === "spawn-error" ||
    value["type"] === "tool-error" ||
    value["type"] === "worker-error"
  ) {
    return Object.keys(value).length === 1;
  }
  return (
    value["type"] === "exited" &&
    Object.keys(value).length === 2 &&
    Number.isSafeInteger(value["exitCode"])
  );
}

function signalOwnedGuardian(
  guardianExited: boolean,
  pid: number,
  signal: NodeJS.Signals,
  kill: typeof process.kill = process.kill,
): boolean {
  if (guardianExited) return false;
  try {
    kill(-pid, signal);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    throw error;
  }
}

async function exitsWithin(
  exited: Promise<number>,
  milliseconds: number,
): Promise<boolean> {
  const timeout = Promise.withResolvers<false>();
  const timer = setTimeout(() => timeout.resolve(false), milliseconds);
  try {
    return await Promise.race([exited.then(() => true), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function cleanupError(command: string, detail: string, cause?: unknown): Error {
  return new Error(`${command} cleanup failed: ${detail}`, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type { CommandGuardian, FinalProtocolMessage };
export {
  finishCommandGuardian,
  signalOwnedGuardian,
  spawnCommandGuardian,
  stopCommandGuardian,
};
