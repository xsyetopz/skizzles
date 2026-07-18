import process from "node:process";
import type {
  ReadableStream,
  ReadableStreamDefaultReader,
  ReadableStreamReadResult,
} from "node:stream/web";
import {
  addFinding,
  type PackageManifest,
  type WorkspaceFinding,
} from "./contract.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const EXPORT_IMPORT_TIMEOUT_MS = 1000;
const EXPORT_IMPORT_CLEANUP_TIMEOUT_MS = 1000;
const EXPORT_IMPORT_GROUP_POLL_INTERVAL_MS = 10;
const HAS_POSIX_PROCESS_GROUPS = process.platform !== "win32";

export async function validateExportImports(
  relativeRoot: string,
  packageRoot: string,
  manifest: PackageManifest,
  findings: WorkspaceFinding[],
): Promise<void> {
  for (const [name, target] of Object.entries(manifest.exports)) {
    if (!SOURCE_EXTENSIONS.has(target.slice(target.lastIndexOf(".")))) {
      continue;
    }
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        'const specifier = process.env.SKIZZLES_EXPORT_SPECIFIER; if (!specifier) throw new Error("missing export specifier"); await import(specifier);',
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          SKIZZLES_EXPORT_SPECIFIER:
            name === "." ? manifest.name : `${manifest.name}${name.slice(1)}`,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: HAS_POSIX_PROCESS_GROUPS,
      },
    );
    const stdout = watchZeroOutput(child.stdout, "stdout");
    const stderr = watchZeroOutput(child.stderr, "stderr");
    let failure = await observeExportImport(child, stdout, stderr);
    if (failure === undefined) {
      const closeFailure = closeExportImportStdin(child);
      if (closeFailure === undefined) {
        stdout.reader.releaseLock();
        stderr.reader.releaseLock();
      } else {
        failure = new ExportImportObservationError(closeFailure);
      }
    }
    if (failure !== undefined) {
      const cleanupFailures = await containFailedExportImport(
        child,
        stdout,
        stderr,
      );
      const reason =
        cleanupFailures.length === 0
          ? failure.message
          : `${failure.message}; cleanup could not establish containment: ${cleanupFailures.join("; ")}`;
      addFinding(
        findings,
        "unsafe-export-import",
        relativeRoot,
        `${name} (${target}) ${reason} during import`,
      );
    }
  }
}

interface ExportImportStreamWatch {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  settled: Promise<void>;
}

class ExportImportObservationError extends Error {}

function watchZeroOutput(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
): ExportImportStreamWatch {
  const reader = stream.getReader();
  const settled = (async (): Promise<void> => {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        throw new ExportImportObservationError(
          `${name} failed while observing import: ${errorDiagnostic(error)}`,
        );
      }
      if (result.done) {
        return;
      }
      if (result.value.byteLength > 0) {
        throw new ExportImportObservationError(`wrote to ${name}`);
      }
    }
  })();
  return { reader, settled };
}

async function observeExportImport(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  stdout: ExportImportStreamWatch,
  stderr: ExportImportStreamWatch,
): Promise<ExportImportObservationError | undefined> {
  const directExit = child.exited.then((exitCode) => {
    if (exitCode !== 0) {
      throw new ExportImportObservationError(`exited with status ${exitCode}`);
    }
  });
  const completed = Promise.all([
    directExit,
    stdout.settled,
    stderr.settled,
  ]).then(
    () => undefined,
    (error: unknown) => observationError(error),
  );
  const deadline = Promise.withResolvers<ExportImportObservationError>();
  const timeout = setTimeout(
    () =>
      deadline.resolve(
        new ExportImportObservationError(
          "did not exit and close stdout and stderr while stdin remained open",
        ),
      ),
    EXPORT_IMPORT_TIMEOUT_MS,
  );
  const failure = await Promise.race([completed, deadline.promise]);
  clearTimeout(timeout);
  if (failure !== undefined) {
    return failure;
  }
  if (HAS_POSIX_PROCESS_GROUPS) {
    const group = probeProcessGroup(child.pid);
    if (group === "present") {
      return new ExportImportObservationError(
        "left a same-group descendant running after import",
      );
    }
    if (group instanceof Error) {
      return new ExportImportObservationError(
        `could not verify process-group exit after import: ${group.message}`,
      );
    }
  }
  return undefined;
}

async function containFailedExportImport(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  stdout: ExportImportStreamWatch,
  stderr: ExportImportStreamWatch,
): Promise<string[]> {
  const failures: string[] = [];
  const signalFailure = killExportImport(child);
  if (signalFailure !== undefined) {
    failures.push(signalFailure);
  }
  const closeFailure = closeExportImportStdin(child);
  if (closeFailure !== undefined) {
    failures.push(closeFailure);
  }

  const cleanupDeadline = Date.now() + EXPORT_IMPORT_CLEANUP_TIMEOUT_MS;
  const readersSettled = await resolveBefore(
    Promise.all([
      cancelReader(stdout.reader, "stdout"),
      cancelReader(stderr.reader, "stderr"),
      stdout.settled.then(
        () => undefined,
        () => undefined,
      ),
      stderr.settled.then(
        () => undefined,
        () => undefined,
      ),
    ]),
    cleanupDeadline,
  );
  if (readersSettled.settled) {
    for (const readerFailure of readersSettled.value.slice(0, 2)) {
      if (readerFailure !== undefined) {
        failures.push(readerFailure);
      }
    }
  } else {
    failures.push(
      "stdout and stderr readers did not settle after cancellation",
    );
  }
  const childReaped = await resolveBefore(
    child.exited.then(
      () => undefined,
      (error: unknown) => errorDiagnostic(error),
    ),
    cleanupDeadline,
  );
  if (!childReaped.settled) {
    failures.push("direct child was not reaped after SIGKILL");
  } else if (childReaped.value !== undefined) {
    failures.push(`direct child reaping failed: ${childReaped.value}`);
  }
  releaseReaderLock(stdout.reader);
  releaseReaderLock(stderr.reader);

  if (HAS_POSIX_PROCESS_GROUPS) {
    const groupFailure = await waitForProcessGroupExit(
      child.pid,
      cleanupDeadline,
    );
    if (groupFailure !== undefined) {
      failures.push(groupFailure);
    }
  }
  return failures;
}

function closeExportImportStdin(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
): string | undefined {
  try {
    child.stdin.end();
    return undefined;
  } catch (error) {
    return `could not close stdin: ${errorDiagnostic(error)}`;
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  name: "stdout" | "stderr",
): Promise<string | undefined> {
  try {
    await reader.cancel();
    return undefined;
  } catch (error) {
    return `could not cancel ${name} reader: ${errorDiagnostic(error)}`;
  }
}

function killExportImport(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
): string | undefined {
  try {
    if (HAS_POSIX_PROCESS_GROUPS) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
    return undefined;
  } catch (error) {
    if (errorCode(error) === "ESRCH") {
      return;
    }
    return `could not SIGKILL ${HAS_POSIX_PROCESS_GROUPS ? `process group ${child.pid}` : `process ${child.pid}`}: ${errorDiagnostic(error)}`;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  deadline: number,
): Promise<string | undefined> {
  while (Date.now() < deadline) {
    const group = probeProcessGroup(pid);
    if (group === "absent") {
      return;
    }
    if (group instanceof Error) {
      return `could not probe process group ${pid}: ${group.message}`;
    }
    await Bun.sleep(EXPORT_IMPORT_GROUP_POLL_INTERVAL_MS);
  }
  return `process group ${pid} survived SIGKILL beyond the cleanup deadline`;
}

function probeProcessGroup(pid: number): "absent" | "present" | Error {
  try {
    process.kill(-pid, 0);
    return "present";
  } catch (error) {
    if (errorCode(error) === "ESRCH") {
      return "absent";
    }
    return new Error(errorDiagnostic(error));
  }
}

type DeadlineResult<T> =
  | { settled: true; value: T }
  | { settled: false; value?: never };

async function resolveBefore<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<DeadlineResult<T>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { settled: false };
  }
  const timeout = Promise.withResolvers<DeadlineResult<T>>();
  const timer = setTimeout(
    () => timeout.resolve({ settled: false }),
    remaining,
  );
  const settled = await Promise.race([
    promise.then((value) => ({ settled: true as const, value })),
    timeout.promise,
  ]);
  clearTimeout(timer);
  return settled;
}

function releaseReaderLock(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    reader.releaseLock();
  } catch {
    // A reader that missed the cleanup deadline remains locked and is reported.
  }
}

function observationError(error: unknown): ExportImportObservationError {
  return error instanceof ExportImportObservationError
    ? error
    : new ExportImportObservationError(
        `failed while observing import lifecycle: ${errorDiagnostic(error)}`,
      );
}

function errorDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error && "code" in error)) {
    return;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
