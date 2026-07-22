import process from "node:process";
import {
  finishCaptures,
  waitForCaptureDrain,
} from "../codex-command/capture-lifecycle.ts";
import type { StreamCaptureState } from "../codex-command/contract.ts";
import {
  type ProcessTreeCleanup,
  terminateProcessTree,
} from "../codex-command/process-tree.ts";
import {
  captureStreamBytes,
  emptyCaptureState,
  type MemoryStreamCapture,
} from "../codex-command/stream-capture.ts";
import {
  invalidSpecInvocationSha256,
  invocationDigest,
  type ParsedCommandObservationSpec,
  parseCommandObservationSpec,
} from "./contract.ts";
import {
  type CommandObservationOutcome,
  type CommandObservationReceipt,
  type CommandOutputStream,
  createObservationReceipt,
} from "./receipt.ts";

type ObservedSubprocess = Bun.Subprocess<"ignore", "pipe", "pipe">;

const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;
const abortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;

interface StopCause {
  readonly kind: "timed-out" | "aborted" | "output-limit";
  readonly outputLimitStream: CommandOutputStream | null;
}

function spawnFailureCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code)) {
      return code;
    }
  }
  return "SPAWN_FAILED";
}

function emptyState(): StreamCaptureState {
  return emptyCaptureState();
}

function emptyReceipt(
  spec: ParsedCommandObservationSpec,
  startedAt: string,
  kind: "aborted" | "spawn-failed",
  failureCode: string | null,
): CommandObservationReceipt {
  return createObservationReceipt({
    invocationSha256: invocationDigest(spec),
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: {
      kind,
      exitCode: null,
      signal: null,
      failureCode,
      outputLimitStream: null,
    },
    lifecycle: { drain: "not-started", cleanup: "not-required" },
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    stdoutObservedBytes: 0,
    stderrObservedBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}

function invalidSpecReceipt(startedAt: string): CommandObservationReceipt {
  return createObservationReceipt({
    invocationSha256: invalidSpecInvocationSha256,
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: {
      kind: "invalid-spec",
      exitCode: null,
      signal: null,
      failureCode: "INVALID_SPEC",
      outputLimitStream: null,
    },
    lifecycle: { drain: "not-started", cleanup: "not-required" },
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    stdoutObservedBytes: 0,
    stderrObservedBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}

function removeAbortListener(
  signal: AbortSignal | undefined,
  listener: () => void,
): void {
  if (!signal) {
    return;
  }
  try {
    removeEventListener.call(signal, "abort", listener);
  } catch {
    // The validated native signal may already be tearing down.
  }
}

function outcomeKind(
  cause: StopCause | undefined,
  signal: string | null,
): Exclude<CommandObservationOutcome, "invalid-spec"> {
  if (cause) {
    return cause.kind;
  }
  return signal === null ? "exited" : "signaled";
}

function captureReceipt(
  spec: ParsedCommandObservationSpec,
  startedAt: string,
  exitCode: number,
  signal: string | null,
  cause: StopCause | undefined,
  drainedNaturally: boolean,
  cleanup: ProcessTreeCleanup,
  stdoutCapture: MemoryStreamCapture,
  stderrCapture: MemoryStreamCapture,
  stdoutState: StreamCaptureState,
  stderrState: StreamCaptureState,
): CommandObservationReceipt {
  return createObservationReceipt({
    invocationSha256: invocationDigest(spec),
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: {
      kind: outcomeKind(cause, signal),
      exitCode,
      signal,
      failureCode: null,
      outputLimitStream: cause?.outputLimitStream ?? null,
    },
    lifecycle: {
      drain: drainedNaturally ? "complete" : "incomplete",
      cleanup,
    },
    stdout: stdoutCapture.bytes(),
    stderr: stderrCapture.bytes(),
    stdoutObservedBytes: stdoutState.observedBytes,
    stderrObservedBytes: stderrState.observedBytes,
    stdoutTruncated: stdoutState.truncated,
    stderrTruncated: stderrState.truncated,
  });
}

export async function observeCommand(
  input: unknown,
): Promise<CommandObservationReceipt> {
  const startedAt = new Date().toISOString();
  const parsed = parseCommandObservationSpec(input);
  if (parsed.kind === "invalid") {
    return invalidSpecReceipt(startedAt);
  }
  const spec = parsed.spec;
  if (spec.abortInitially) {
    return emptyReceipt(spec, startedAt, "aborted", null);
  }

  let abortPending = false;
  let requestAbort: (() => void) | undefined;
  const abort = (): void => {
    abortPending = true;
    requestAbort?.();
  };
  if (spec.abortSignal) {
    try {
      if (!abortedGetter) {
        return invalidSpecReceipt(startedAt);
      }
      addEventListener.call(spec.abortSignal, "abort", abort, { once: true });
      const aborted = abortedGetter.call(spec.abortSignal) as unknown;
      if (typeof aborted !== "boolean") {
        removeAbortListener(spec.abortSignal, abort);
        return invalidSpecReceipt(startedAt);
      }
      if (aborted) {
        removeAbortListener(spec.abortSignal, abort);
        return emptyReceipt(spec, startedAt, "aborted", null);
      }
    } catch {
      removeAbortListener(spec.abortSignal, abort);
      return invalidSpecReceipt(startedAt);
    }
  }

  let child: ObservedSubprocess;
  try {
    child = Bun.spawn([...spec.argv], {
      cwd: spec.cwd,
      env: { ...spec.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch (error) {
    removeAbortListener(spec.abortSignal, abort);
    return emptyReceipt(
      spec,
      startedAt,
      "spawn-failed",
      spawnFailureCode(error),
    );
  }

  let cause: StopCause | undefined;
  let cleanupPromise: Promise<ProcessTreeCleanup> | undefined;
  const stop = (nextCause: StopCause): void => {
    if (cause !== undefined) {
      return;
    }
    cause = nextCause;
    cleanupPromise = terminateProcessTree(child, spec.signalGraceMilliseconds);
  };
  requestAbort = () => stop({ kind: "aborted", outputLimitStream: null });
  if (abortPending) {
    requestAbort();
  }
  const stdoutState = emptyState();
  const stderrState = emptyState();
  const stdoutCapture = captureStreamBytes(
    child.stdout,
    spec.maximumOutputBytes,
    stdoutState,
    () => stop({ kind: "output-limit", outputLimitStream: "stdout" }),
  );
  const stderrCapture = captureStreamBytes(
    child.stderr,
    spec.maximumOutputBytes,
    stderrState,
    () => stop({ kind: "output-limit", outputLimitStream: "stderr" }),
  );
  const captures = [stdoutCapture, stderrCapture] as const;
  const timeout = setTimeout(
    () => stop({ kind: "timed-out", outputLimitStream: null }),
    spec.timeoutMilliseconds,
  );
  timeout.unref();

  try {
    const exitCode = await child.exited;
    clearTimeout(timeout);
    const drainedNaturally = await waitForCaptureDrain(
      captures,
      spec.drainMilliseconds,
    );
    cleanupPromise ??= terminateProcessTree(
      child,
      spec.signalGraceMilliseconds,
    );
    const cleanup = await cleanupPromise;
    await finishCaptures(captures);
    const childSignal = child.signalCode;
    const signal = typeof childSignal === "string" ? childSignal : null;
    return captureReceipt(
      spec,
      startedAt,
      exitCode,
      signal,
      cause,
      drainedNaturally,
      cleanup,
      stdoutCapture,
      stderrCapture,
      stdoutState,
      stderrState,
    );
  } finally {
    clearTimeout(timeout);
    removeAbortListener(spec.abortSignal, abort);
  }
}
