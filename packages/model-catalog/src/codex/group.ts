import process from "node:process";
import type { OwnedChild } from "@skizzles/scratchspace";

const FORCED_EXIT_TIMEOUT_MS = 2000;

type CodexSupervisorSubprocess = Bun.Subprocess<"ignore", "pipe", "pipe">;

function signalOwnedCodexSupervisor(
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

async function settlesWithin(
  settled: Promise<number>,
  milliseconds: number,
): Promise<boolean> {
  const timeout = Promise.withResolvers<false>();
  const timer = setTimeout(() => timeout.resolve(false), milliseconds);
  try {
    return await Promise.race([
      settled.then(() => true as const),
      timeout.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CodexProcessGroup extends OwnedChild {
  stopWithin: (graceMs: number) => Promise<void>;
}

function codexSupervisorGroup(
  child: CodexSupervisorSubprocess,
  label: string,
  kill: typeof process.kill = process.kill,
): CodexProcessGroup {
  let exitObserved = false;
  const signal = (value: NodeJS.Signals): boolean => {
    if (exitObserved) return false;
    const supervisorExited = child.exitCode !== null;
    if (supervisorExited) {
      exitObserved = true;
      return false;
    }
    return signalOwnedCodexSupervisor(false, child.pid, value, kill);
  };
  const waitForExit = async (): Promise<void> => {
    if (exitObserved) return;
    await child.exited;
    exitObserved = true;
  };
  const stopWithin = async (graceMs: number): Promise<void> => {
    let gracefulError: unknown;
    try {
      signal("SIGTERM");
    } catch (error) {
      gracefulError = error;
    }
    if (
      exitObserved ||
      (gracefulError === undefined &&
        (await settlesWithin(child.exited, graceMs)))
    ) {
      exitObserved = true;
      return;
    }
    try {
      signal("SIGKILL");
    } catch (forceError) {
      if (gracefulError !== undefined) {
        throw new AggregateError(
          [gracefulError, forceError],
          "Codex supervisor termination signals failed",
        );
      }
      throw forceError;
    }
    if (exitObserved) return;
    if (!(await settlesWithin(child.exited, FORCED_EXIT_TIMEOUT_MS))) {
      const error = new Error("Codex supervisor survived forced termination");
      if (gracefulError !== undefined) {
        throw new AggregateError(
          [gracefulError, error],
          "Codex supervisor cleanup failed",
        );
      }
      throw error;
    }
    exitObserved = true;
  };
  return {
    label,
    pid: child.pid,
    requestStop: () => {
      signal("SIGTERM");
    },
    forceStop: () => {
      signal("SIGKILL");
    },
    waitForExit,
    stopWithin,
  };
}

export { codexSupervisorGroup, signalOwnedCodexSupervisor };
