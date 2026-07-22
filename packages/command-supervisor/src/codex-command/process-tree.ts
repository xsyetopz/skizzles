import process from "node:process";

interface ProcessTreeChild {
  readonly pid: number;
  kill: (signal?: NodeJS.Signals | number) => void;
}

type SignalTarget = NodeJS.Signals | "SIGKILL";
type ProcessTreeCleanup = "not-required" | "terminated" | "killed";

const forcedExitWaitMilliseconds = 500;

function missingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

export function signalProcessTree(
  child: ProcessTreeChild,
  signal: SignalTarget,
): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (missingProcess(error)) {
        return;
      }
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between observation and delivery.
  }
}

export function processTreeExists(child: ProcessTreeChild): boolean {
  try {
    let target = -child.pid;
    if (process.platform === "win32") {
      target = child.pid;
    }
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessTreeExit(
  child: ProcessTreeChild,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    if (!processTreeExists(child)) {
      return true;
    }
    await Bun.sleep(10);
  }
  return !processTreeExists(child);
}

export async function terminateProcessTree(
  child: ProcessTreeChild,
  signalGraceMilliseconds: number,
): Promise<ProcessTreeCleanup> {
  if (!processTreeExists(child)) {
    return "not-required";
  }
  signalProcessTree(child, "SIGTERM");
  const exitedGracefully = await waitForProcessTreeExit(
    child,
    signalGraceMilliseconds,
  );
  if (exitedGracefully) {
    return "terminated";
  }
  signalProcessTree(child, "SIGKILL");
  await waitForProcessTreeExit(child, forcedExitWaitMilliseconds);
  return "killed";
}

export type { ProcessTreeChild, ProcessTreeCleanup };
