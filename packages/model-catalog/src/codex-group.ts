import process from "node:process";
import type { OwnedChild } from "@skizzles/run-workspace";

const EXIT_POLL_MS = 10;
const FORCED_EXIT_TIMEOUT_MS = 2_000;

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function settlesWithin(
  settled: Promise<void>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      timer = undefined;
      resolve(false);
    }, milliseconds);
  });
  try {
    return await Promise.race([settled.then(() => true as const), elapsed]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface CodexProcessGroup extends OwnedChild {
  stopWithin: (graceMs: number) => Promise<void>;
}

export function codexProcessGroup(
  pid: number,
  label: string,
): CodexProcessGroup {
  let absent = false;
  let exit: Promise<void> | undefined;
  const observeExit = async (): Promise<void> => {
    while (!absent) {
      if (!signalGroup(pid, 0)) {
        absent = true;
        return;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Process-group absence is a sequential operating-system observation, not parallel work.
      await Bun.sleep(EXIT_POLL_MS);
    }
  };
  const waitForExit = (): Promise<void> => {
    exit ??= observeExit();
    return exit;
  };
  const requestStop = (): void => {
    if (absent) {
      return;
    }
    if (!signalGroup(pid, "SIGTERM")) {
      absent = true;
    }
  };
  const forceStop = (): void => {
    if (absent) {
      return;
    }
    if (!signalGroup(pid, "SIGKILL")) {
      absent = true;
    }
  };
  const stopWithin = async (graceMs: number): Promise<void> => {
    requestStop();
    if (await settlesWithin(waitForExit(), graceMs)) {
      return;
    }
    forceStop();
    if (!(await settlesWithin(waitForExit(), FORCED_EXIT_TIMEOUT_MS))) {
      throw new Error("Codex process group survived forced termination");
    }
  };
  return {
    label,
    pid,
    requestStop,
    forceStop,
    waitForExit,
    stopWithin,
  };
}
