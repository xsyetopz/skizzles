import process from "node:process";

const TERMINATION_GRACE_MS = 250;
const TERMINATION_CONFIRMATION_MS = 2000;
const GROUP_POLL_MS = 10;

async function cleanupOwnedProcess(
  processGroup: number | undefined,
  command: string,
): Promise<void> {
  if (processGroup === undefined) {
    return;
  }
  if (!processGroupExists(processGroup, command)) {
    return;
  }
  if (!signalProcessGroup(processGroup, "SIGTERM", command)) {
    return;
  }
  if (
    await waitForProcessGroupExit(processGroup, TERMINATION_GRACE_MS, command)
  ) {
    return;
  }
  if (!signalProcessGroup(processGroup, "SIGKILL", command)) {
    return;
  }
  if (
    await waitForProcessGroupExit(
      processGroup,
      TERMINATION_CONFIRMATION_MS,
      command,
    )
  ) {
    return;
  }
  throw new Error(
    `${command} cleanup failed: process group ${processGroup} remains after SIGKILL`,
  );
}

function signalProcessGroup(
  processGroup: number,
  signal: NodeJS.Signals,
  command: string,
): boolean {
  try {
    process.kill(-processGroup, signal);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) {
      return false;
    }
    throw new Error(
      `${command} cleanup failed: cannot send ${signal} to process group ${processGroup}: ${asError(error).message}`,
      { cause: error },
    );
  }
}

function processGroupExists(processGroup: number, command: string): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) {
      return false;
    }
    if (isPermissionDenied(error)) {
      return true;
    }
    throw new Error(
      `${command} cleanup failed: cannot verify process group ${processGroup}: ${asError(error).message}`,
      { cause: error },
    );
  }
}

async function waitForProcessGroupExit(
  processGroup: number,
  timeoutMs: number,
  command: string,
): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      try {
        if (!processGroupExists(processGroup, command)) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(poll, GROUP_POLL_MS);
      } catch (error) {
        reject(error);
      }
    };
    poll();
  });
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EPERM"
  );
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export { cleanupOwnedProcess };
