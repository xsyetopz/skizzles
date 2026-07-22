import {
  type CleanupReport,
  type CreateOptions,
  cleanupStale,
  create,
  type RunWorkspace,
  RunWorkspaceAbortedError,
} from "@skizzles/scratchspace";

interface InstallerLifecycle {
  cleanupStale: () => Promise<CleanupReport>;
  create: (options?: CreateOptions) => Promise<RunWorkspace>;
}

const systemLifecycle: InstallerLifecycle = { cleanupStale, create };

export async function runInstallerOperation<T>(
  operation: (workspace: RunWorkspace) => Promise<T>,
): Promise<T> {
  return await runInstallerOperationWithLifecycle(operation, systemLifecycle);
}

async function runInstallerOperationWithLifecycle<T>(
  operation: (workspace: RunWorkspace) => Promise<T>,
  lifecycle: InstallerLifecycle,
): Promise<T> {
  const stale = await lifecycle.cleanupStale();
  if (stale.failed.length > 0 || stale.truncated) {
    throw new Error("installer stale workspace cleanup failed");
  }
  const workspace = await lifecycle.create({ handleSignals: true });
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      const abort = (): void => reject(workspace.signal.reason);
      workspace.signal.addEventListener("abort", abort, { once: true });
      if (workspace.signal.aborted) abort();
    });
    outcome = {
      ok: true,
      value: await Promise.race([operation(workspace), interrupted]),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let report: Awaited<ReturnType<RunWorkspace["close"]>>;
  try {
    report = await workspace.close();
  } catch (error) {
    throw new Error("installer temporary cleanup failed", {
      cause: outcome.ok
        ? error
        : new AggregateError(
            [error, outcome.error],
            "workspace cleanup and installer operation both failed",
          ),
    });
  }
  if (report.state === "cleanup-failed") {
    const cleanupError = new Error(
      `installer temporary cleanup failed: ${report.error ?? "CLEANUP_FAILED"}`,
    );
    throw new Error(cleanupError.message, {
      cause: outcome.ok
        ? cleanupError
        : new AggregateError(
            [cleanupError, outcome.error],
            "workspace cleanup and installer operation both failed",
          ),
    });
  }
  if (workspace.signal.reason instanceof RunWorkspaceAbortedError) {
    throw workspace.signal.reason;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export { type InstallerLifecycle, runInstallerOperationWithLifecycle };
