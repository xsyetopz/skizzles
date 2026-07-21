import type { CommandResult, RunOptions } from "./contract.ts";
import {
  type CommandGuardian,
  type FinalProtocolMessage,
  finishCommandGuardian,
  spawnCommandGuardian,
  stopCommandGuardian,
} from "./supervisor.ts";

const DEFAULT_OUTPUT_BYTES = 4_194_304;
const TERMINATION_GRACE_MS = 250;
const TIMEOUT_EXIT_CODE = 124;

interface CapturedOutput {
  readonly bytes: Uint8Array;
  readonly overflow: boolean;
}

type CleanupMode = "external-stop" | "terminal";

interface ExecutionState {
  abortRequested: boolean;
  failure: Error | undefined;
  outputLimitExceeded: "stderr" | "stdout" | undefined;
  timedOut: boolean;
}

async function executeCommand(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  const cap = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  let guardian: CommandGuardian;
  try {
    guardian = spawnCommandGuardian(command, args, options);
  } catch (error) {
    throw asError(error);
  }
  const state: ExecutionState = {
    abortRequested: false,
    failure: undefined,
    outputLimitExceeded: undefined,
    timedOut: false,
  };
  const stop = Promise.withResolvers<CleanupMode>();
  const requestExternalStop = (): void => stop.resolve("external-stop");
  const outputAbort = new AbortController();
  const stdout = collectBounded(
    guardian.child.stdout,
    cap,
    "stdout",
    options.rejectOnOutputLimit === true,
    state,
    requestExternalStop,
    outputAbort.signal,
  );
  const stderr = collectBounded(
    guardian.child.stderr,
    cap,
    "stderr",
    options.rejectOnOutputLimit === true,
    state,
    requestExternalStop,
    outputAbort.signal,
  );
  const abort = (): void => {
    state.abortRequested = true;
    requestExternalStop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          state.timedOut = true;
          requestExternalStop();
        }, options.timeoutMs);

  let protocol: FinalProtocolMessage | undefined;
  const protocolOutcome = guardian.final.then(
    (message) => {
      protocol = message;
      stop.resolve("terminal");
    },
    (error) => {
      state.failure = asError(error);
      requestExternalStop();
    },
  );
  const guardianExit = guardian.child.exited.then(() => {
    if (protocol === undefined && state.failure === undefined) {
      state.failure = new Error(`${command} guardian exited unexpectedly`);
      requestExternalStop();
    }
  });

  const cleanupMode = await stop.promise;
  let cleanupFailure: unknown;
  try {
    if (cleanupMode === "external-stop") {
      await stopCommandGuardian(guardian, command, TERMINATION_GRACE_MS);
    } else {
      await finishCommandGuardian(guardian, command);
    }
  } catch (error) {
    cleanupFailure = error;
    outputAbort.abort();
  }
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", abort);
  if (cleanupFailure === undefined) {
    await Promise.allSettled([protocolOutcome, guardianExit]);
  }
  let captured: readonly [CapturedOutput, CapturedOutput];
  try {
    captured = await Promise.all([stdout, stderr]);
  } catch (error) {
    state.failure ??= asError(error);
    captured = [emptyOutput(), emptyOutput()];
  } finally {
    outputAbort.abort();
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;

  const [capturedStdout, capturedStderr] = captured;
  if (state.abortRequested || options.signal?.aborted) {
    throw new Error(`${command} aborted`);
  }
  if (state.outputLimitExceeded !== undefined) {
    throw new Error(
      `${command} ${state.outputLimitExceeded} exceeded ${cap} byte output limit`,
    );
  }
  if (state.timedOut) {
    const result = {
      code: TIMEOUT_EXIT_CODE,
      stdout: Buffer.from(capturedStdout.bytes),
      stderr: Buffer.from(capturedStderr.bytes),
    };
    if (!options.allowFailure) {
      throw new Error(
        `${command} ${args.join(" ")} failed (${result.code}): ${result.stderr.toString().trim()}`,
      );
    }
    return result;
  }
  if (state.failure !== undefined) throw state.failure;
  if (protocol === undefined || !("exitCode" in protocol)) {
    throw new Error(`${command} process execution failed`);
  }
  const result = {
    code: protocol.exitCode,
    stdout: Buffer.from(capturedStdout.bytes),
    stderr: Buffer.from(capturedStderr.bytes),
  };
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.code}): ${result.stderr.toString().trim()}`,
    );
  }
  return result;
}

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  name: "stderr" | "stdout",
  rejectOnOverflow: boolean,
  state: ExecutionState,
  stop: () => void,
  signal: AbortSignal,
): Promise<CapturedOutput> {
  const chunks: Uint8Array[] = [];
  let observed = 0;
  const reader = stream.getReader();
  const cancel = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (observed < cap) chunks.push(value.subarray(0, cap - observed));
      observed += value.byteLength;
      if (
        observed > cap &&
        rejectOnOverflow &&
        state.outputLimitExceeded === undefined
      ) {
        state.outputLimitExceeded = name;
        stop();
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const length = Math.min(observed, cap);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflow: observed > cap };
}

function emptyOutput(): CapturedOutput {
  return { bytes: new Uint8Array(), overflow: false };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export { executeCommand };
