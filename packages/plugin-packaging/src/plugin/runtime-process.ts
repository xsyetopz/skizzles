import { mkdir } from "node:fs/promises";
import process from "node:process";
import type { OwnedChild } from "@skizzles/scratchspace";
import {
  INSTALLER_SMOKE_OUTPUT_LIMIT,
  INSTALLER_SMOKE_TERM_GRACE_MS,
  INSTALLER_SMOKE_TIMEOUT_MS,
  PackagingError,
} from "./contract.ts";
import type { PluginWorkspace } from "./workspace.ts";

const GROUP_EXIT_TIMEOUT_MS = 2000;
const GROUP_POLL_MS = 10;

const WORKER_SOURCE = String.raw`
const installerRoot = Bun.argv[1];
const publish = async (message) => {
  try {
    process.send?.(message);
  } catch {}
};
try {
  const tool = Bun.spawn([process.execPath, "src/cli.ts", "--help"], {
    cwd: installerRoot,
    env: process.env,
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
`;

const GUARDIAN_SOURCE = String.raw`
const installerRoot = Bun.argv[1];
const workerSource = ${JSON.stringify(WORKER_SOURCE)};
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 2_147_483_647);
const publish = (message) => {
  try {
    process.send?.(message);
  } catch {}
};
let state = "pending";
let final = false;
let worker;
try {
  worker = Bun.spawn([process.execPath, "--eval", workerSource, installerRoot], {
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

interface BoundedOutput {
  overflow: boolean;
  text: string;
}

interface InstallerOutcome {
  exitCode: number;
  stderr: BoundedOutput;
  stdout: BoundedOutput;
}

type ProtocolMessage =
  | { readonly type: "ready" }
  | { readonly type: "spawn-error" | "tool-error" | "worker-error" }
  | { readonly exitCode: number; readonly type: "exited" };

type FinalProtocolMessage = Exclude<
  ProtocolMessage,
  { readonly type: "ready" }
>;

interface InstallerGuardianRuntime {
  readonly source: string;
}

function runInstallerHelp(
  installerRoot: string,
  workspace: PluginWorkspace,
): Promise<InstallerOutcome> {
  return runInstallerHelpUsing(installerRoot, workspace, systemRuntime);
}

async function runInstallerHelpUsing(
  installerRoot: string,
  workspace: PluginWorkspace,
  runtime: InstallerGuardianRuntime,
): Promise<InstallerOutcome> {
  assertSupervisorPlatform(process.platform);
  const processTemp = workspace.path(
    "process-temp",
    `installer-help-${crypto.randomUUID()}`,
  );
  await mkdir(processTemp, { recursive: true, mode: 0o700 });
  const protocol = protocolReceiver();
  const child = Bun.spawn(
    [process.execPath, "--eval", runtime.source, installerRoot],
    {
      detached: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        TEMP: processTemp,
        TMP: processTemp,
        TMPDIR: processTemp,
      },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
      ipc: protocol.receive,
    },
  );
  const owned = ownGuardian(child);
  try {
    workspace.registerChild(owned);
  } catch (error) {
    await owned.forceStop();
    await owned.waitForExit();
    throw error;
  }
  const outputAbort = new AbortController();
  const output = Promise.all([
    readBoundedOutput(child.stdout, outputAbort.signal),
    readBoundedOutput(child.stderr, outputAbort.signal),
  ]);
  const deadline = Promise.withResolvers<"deadline">();
  const timer = setTimeout(
    () => deadline.resolve("deadline"),
    INSTALLER_SMOKE_TIMEOUT_MS,
  );
  let protocolOutcome:
    | { readonly message: FinalProtocolMessage; readonly ok: true }
    | { readonly error: unknown; readonly ok: false };
  try {
    const message = await Promise.race([
      protocol.final,
      child.exited.then(() => {
        throw validationError();
      }),
      deadline.promise,
    ]);
    protocolOutcome =
      message === "deadline"
        ? { error: validationError(), ok: false }
        : { message, ok: true };
  } catch (error) {
    protocolOutcome = { error, ok: false };
  } finally {
    clearTimeout(timer);
  }
  if (!protocolOutcome.ok) outputAbort.abort();
  let teardownFailure: unknown;
  try {
    await teardownGuardian(owned, child.exited);
  } catch (error) {
    teardownFailure = error;
  }
  let outputOutcome:
    | {
        readonly ok: true;
        readonly value: readonly [BoundedOutput, BoundedOutput];
      }
    | { readonly error: unknown; readonly ok: false };
  try {
    outputOutcome = { ok: true, value: await output };
  } catch (error) {
    outputOutcome = { error, ok: false };
  } finally {
    outputAbort.abort();
  }
  if (teardownFailure !== undefined) {
    const causes: unknown[] = [teardownFailure];
    if (!protocolOutcome.ok) causes.push(protocolOutcome.error);
    if (!outputOutcome.ok) causes.push(outputOutcome.error);
    throw new PackagingError("Packaged installer runtime cleanup failed.", {
      cause:
        causes.length === 1
          ? teardownFailure
          : new AggregateError(
              causes,
              "Installer validation and cleanup failed.",
            ),
    });
  }
  if (!protocolOutcome.ok) throw protocolOutcome.error;
  if (!outputOutcome.ok) throw outputOutcome.error;
  const [stdout, stderr] = outputOutcome.value;
  const message = protocolOutcome.message;
  if (message.type !== "exited") {
    throw validationError();
  }
  return { exitCode: message.exitCode, stderr, stdout };
}

const systemRuntime: InstallerGuardianRuntime = {
  source: GUARDIAN_SOURCE,
};

async function teardownGuardian(
  owned: OwnedChild,
  exited: Promise<number>,
): Promise<void> {
  let stopFailure: unknown;
  try {
    await owned.requestStop();
  } catch (error) {
    stopFailure = error;
  }
  if (!(await exitsWithin(exited, INSTALLER_SMOKE_TERM_GRACE_MS))) {
    try {
      await owned.forceStop();
    } catch (error) {
      stopFailure =
        stopFailure === undefined
          ? error
          : new AggregateError(
              [stopFailure, error],
              "Installer supervisor stop and force both failed.",
            );
    }
  }
  try {
    await owned.waitForExit();
  } catch (error) {
    if (stopFailure === undefined) throw error;
    throw new AggregateError(
      [stopFailure, error],
      "Installer supervisor stop and exit proof both failed.",
    );
  }
  if (stopFailure !== undefined) throw stopFailure;
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
  if (!isProtocolMessage(value)) return validationError();
  if (value.type === "ready") {
    return state === "pending" ? value : validationError();
  }
  if (value.type === "spawn-error") {
    return state === "pending" ? value : validationError();
  }
  if (value.type === "worker-error") return value;
  return state === "ready" ? value : validationError();
}

function validationError(): PackagingError {
  return new PackagingError("Packaged installer runtime validation failed.");
}

/*
 * Root IPC terminates at the guardian. The guardian creates a distinct IPC
 * channel to its worker; the worker's tool has no IPC channel.
 */

function assertSupervisorPlatform(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new PackagingError(
      "Packaged installer runtime validation requires POSIX process-group ownership.",
    );
  }
}

function ownGuardian(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
): OwnedChild {
  let confirmed = false;
  const signal = (value: NodeJS.Signals): void => {
    if (confirmed) return;
    signalOwnedGuardian(child.exitCode !== null, child.pid, value);
  };
  return {
    label: "packaged installer help guardian",
    pid: child.pid,
    requestStop: () => signal("SIGTERM"),
    forceStop: () => signal("SIGKILL"),
    waitForExit: async () => {
      if (confirmed) return;
      if (!(await exitsWithin(child.exited, GROUP_EXIT_TIMEOUT_MS))) {
        throw new PackagingError("Packaged installer runtime cleanup failed.");
      }
      await requireGroupAbsent(child.pid);
      confirmed = true;
    },
  };
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

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<BoundedOutput> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  const reader = stream.getReader();
  const cancel = () => reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes < INSTALLER_SMOKE_OUTPUT_LIMIT) {
        chunks.push(value.subarray(0, INSTALLER_SMOKE_OUTPUT_LIMIT - bytes));
      }
      bytes += value.byteLength;
      overflow ||= bytes > INSTALLER_SMOKE_OUTPUT_LIMIT;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return {
    overflow,
    text: new TextDecoder().decode(Buffer.concat(chunks)),
  };
}

async function requireGroupAbsent(pid: number): Promise<void> {
  const deadline = performance.now() + GROUP_EXIT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (!groupExists(pid)) return;
    await Bun.sleep(GROUP_POLL_MS);
  }
  if (groupExists(pid)) {
    throw new PackagingError("Packaged installer runtime validation failed.");
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    return true;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export {
  assertSupervisorPlatform,
  runInstallerHelp,
  runInstallerHelpUsing,
  signalOwnedGuardian,
};
