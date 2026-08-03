import { spawn } from "node:child_process";

export type OutputCapturePolicy = "head" | "tail";
export type CommandResult = {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};
export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowFailure?: boolean;
  maxOutputBytes?: number;
  rejectOnOutputLimit?: boolean;
  stdoutCapture?: OutputCapturePolicy;
  stderrCapture?: OutputCapturePolicy;
  signal?: AbortSignal;
};

type CaptureState = {
  chunks: Buffer[];
  bytes: number;
  totalBytes: number;
  truncated: boolean;
  policy: OutputCapturePolicy;
};

export async function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  if (options.signal?.aborted) throw new Error(`${command} aborted`);

  return await new Promise<CommandResult>((resolve, reject) => {
    const ownsProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: ownsProcessGroup,
    });
    const cap = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const stdout = captureState(options.stdoutCapture);
    const stderr = captureState(options.stderrCapture);
    let timedOut = false;
    let cleanupStarted = false;
    let cleanupSignalSent = false;
    let forceKillSent = false;
    let cleanupError: Error | undefined;
    let outputOverflow: "stdout" | "stderr" | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let closeCode: number | null = null;
    let closeObserved = false;
    let settled = false;

    const signalTree = (signal: NodeJS.Signals): boolean => {
      try {
        if (ownsProcessGroup && child.pid !== undefined) {
          process.kill(-child.pid, signal);
          return true;
        }
        return child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        cleanupError = new Error(
          `${command} cleanup failed sending ${signal}: ${(error as Error).message}`,
        );
        return false;
      }
    };
    const settle = () => {
      if (settled || !closeObserved || (cleanupSignalSent && !forceKillSent)) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      if (cleanupError) return reject(cleanupError);
      if (outputOverflow) {
        return reject(new Error(`${command} ${outputOverflow} exceeded ${cap} byte output limit`));
      }
      const result = {
        code: timedOut ? 124 : (closeCode ?? 1),
        stdout: Buffer.concat(stdout.chunks),
        stderr: Buffer.concat(stderr.chunks),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
      if (options.signal?.aborted) return reject(new Error(`${command} aborted`));
      if (result.code !== 0 && !options.allowFailure) {
        return reject(new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.stderr.toString().trim()}`));
      }
      resolve(result);
    };
    const terminate = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      if (!ownsProcessGroup) {
        forceKillSent = true;
        signalTree("SIGKILL");
        return;
      }
      if (signalTree("SIGTERM")) {
        cleanupSignalSent = true;
        forceKill = setTimeout(() => {
          forceKill = undefined;
          forceKillSent = true;
          signalTree("SIGKILL");
          settle();
        }, 100);
      }
    };
    const collect = (stream: "stdout" | "stderr", state: CaptureState, chunk: Buffer): void => {
      collectOutput(state, chunk, cap);
      if (options.rejectOnOutputLimit && state.totalBytes > cap && outputOverflow === undefined) {
        outputOverflow = stream;
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", stderr, chunk));
    const abort = () => terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    timeout = options.timeoutMs ? setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs) : undefined;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", terminate);
    child.once("close", (code) => {
      closeCode = code;
      closeObserved = true;
      settle();
    });
  });
}

function captureState(policy: OutputCapturePolicy | undefined): CaptureState {
  return { chunks: [], bytes: 0, totalBytes: 0, truncated: false, policy: policy ?? "head" };
}

function collectOutput(state: CaptureState, chunk: Buffer, cap: number): void {
  state.totalBytes += chunk.byteLength;
  if (state.totalBytes > cap) state.truncated = true;
  if (cap <= 0) return;
  if (state.policy === "head") {
    const remaining = cap - state.bytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      state.chunks.push(retained);
      state.bytes += retained.byteLength;
    }
    return;
  }
  if (chunk.byteLength >= cap) {
    const retained = Buffer.from(chunk.subarray(chunk.byteLength - cap));
    state.chunks = [retained];
    state.bytes = retained.byteLength;
    return;
  }
  let excess = state.bytes + chunk.byteLength - cap;
  while (excess > 0 && state.chunks.length > 0) {
    const first = state.chunks[0]!;
    if (first.byteLength <= excess) {
      state.chunks.shift();
      state.bytes -= first.byteLength;
      excess -= first.byteLength;
    } else {
      state.chunks[0] = first.subarray(excess);
      state.bytes -= excess;
      excess = 0;
    }
  }
  state.chunks.push(chunk);
  state.bytes += chunk.byteLength;
}
