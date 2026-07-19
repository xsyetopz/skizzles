import { type ChildProcessByStdio, spawn } from "node:child_process";
import process from "node:process";
import type { Readable } from "node:stream";
import type { CommandResult, RunOptions } from "./contract.ts";
import { cleanupOwnedProcess } from "./group.ts";
import { assertProcessPlatform } from "./platform.ts";

const DEFAULT_OUTPUT_BYTES = 4_194_304;
const PIPE_RELEASE_GRACE_MS = 250;
const TIMEOUT_EXIT_CODE = 124;

type SpawnedCommand = ChildProcessByStdio<null, Readable, Readable>;
type ResolveCommand = (result: CommandResult) => void;
type RejectCommand = (error: Error) => void;

interface ExecutionState {
  closeCode: number | null | undefined;
  closeObserved: boolean;
  exitObserved: boolean;
  pipesReleased: boolean;
  timedOut: boolean;
  abortRequested: boolean;
  processError: Error | undefined;
  cleanupError: Error | undefined;
}

class CommandExecution {
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private readonly cap: number;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private outputLimitExceeded: "stderr" | "stdout" | undefined;
  private child: SpawnedCommand | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private pipeRelease: ReturnType<typeof setTimeout> | undefined;
  private cleanup: Promise<void> | undefined;
  private cleanupFinished = false;
  private resolve: ResolveCommand | undefined;
  private reject: RejectCommand | undefined;
  private readonly command: string;
  private readonly args: string[];
  private readonly options: RunOptions;
  private readonly state: ExecutionState = {
    closeCode: undefined,
    closeObserved: false,
    exitObserved: false,
    pipesReleased: false,
    timedOut: false,
    abortRequested: false,
    processError: undefined,
    cleanupError: undefined,
  };

  constructor(command: string, args: string[], options: RunOptions) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.cap = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  }

  execute(): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.start();
    });
  }

  private start(): void {
    this.options.signal?.addEventListener("abort", this.onAbort, {
      once: true,
    });
    if (this.options.signal?.aborted) {
      this.finishBeforeSpawn(new Error(`${this.command} aborted`));
      return;
    }
    try {
      this.child = spawn(this.command, this.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      this.finishBeforeSpawn(asError(error));
      return;
    }
    this.attachChild(this.child);
    if (this.state.abortRequested || this.options.signal?.aborted) {
      this.state.abortRequested = true;
      this.confirmCleanup();
    }
    if (this.options.timeoutMs) {
      this.timeout = setTimeout(this.onTimeout, this.options.timeoutMs);
    }
  }

  private attachChild(child: SpawnedCommand): void {
    child.stdout.on("data", this.onStdout);
    child.stderr.on("data", this.onStderr);
    child.stdout.once("error", this.onStreamError);
    child.stderr.once("error", this.onStreamError);
    child.once("error", this.onProcessError);
    child.once("exit", this.onExit);
    child.once("close", this.onClose);
  }

  private readonly onAbort = (): void => {
    this.state.abortRequested = true;
    if (this.child !== undefined) {
      this.confirmCleanup();
    }
  };

  private readonly onTimeout = (): void => {
    this.state.timedOut = true;
    this.confirmCleanup();
  };

  private readonly onStdout = (chunk: Buffer): void => {
    this.stdoutBytes = this.collect(
      "stdout",
      this.stdout,
      chunk,
      this.stdoutBytes,
    );
  };

  private readonly onStderr = (chunk: Buffer): void => {
    this.stderrBytes = this.collect(
      "stderr",
      this.stderr,
      chunk,
      this.stderrBytes,
    );
  };

  private readonly onStreamError = (error: Error): void => {
    this.state.processError ??= error;
    this.confirmCleanup();
  };

  private readonly onProcessError = (error: Error): void => {
    this.state.processError = error;
    this.confirmCleanup();
    if (this.child?.pid === undefined) {
      this.state.closeObserved = true;
      this.state.pipesReleased = true;
      this.finish();
    }
  };

  private readonly onExit = (code: number | null): void => {
    this.state.exitObserved = true;
    this.state.closeCode = code;
    this.clearTimeout();
    this.confirmCleanup();
  };

  private readonly onClose = (code: number | null): void => {
    this.state.closeObserved = true;
    this.state.closeCode = code;
    this.clearTimeout();
    this.confirmCleanup();
    this.finish();
  };

  private collect(
    stream: "stderr" | "stdout",
    chunks: Buffer[],
    chunk: Buffer,
    current: number,
  ): number {
    const remaining = this.cap - current;
    if (remaining > 0) {
      chunks.push(chunk.subarray(0, remaining));
    }
    const next = current + chunk.byteLength;
    if (
      next > this.cap &&
      this.options.rejectOnOutputLimit === true &&
      this.outputLimitExceeded === undefined
    ) {
      this.outputLimitExceeded = stream;
      this.confirmCleanup();
    }
    return next;
  }

  private confirmCleanup(): void {
    if (this.cleanup !== undefined) {
      return;
    }
    this.cleanup = cleanupOwnedProcess(this.child?.pid, this.command);
    this.cleanup.then(this.onCleanupSuccess, this.onCleanupFailure);
  }

  private readonly onCleanupSuccess = (): void => {
    this.cleanupFinished = true;
    this.releasePipesIfCloseIsHeld();
    this.finish();
  };

  private readonly onCleanupFailure = (error: unknown): void => {
    this.state.cleanupError = asError(error);
    this.cleanupFinished = true;
    this.releasePipes();
    this.finish();
  };

  private releasePipesIfCloseIsHeld(): void {
    if (this.state.closeObserved || !this.state.exitObserved) {
      return;
    }
    this.pipeRelease = setTimeout(() => {
      this.releasePipes();
      this.finish();
    }, PIPE_RELEASE_GRACE_MS);
  }

  private releasePipes(): void {
    if (this.state.pipesReleased) {
      return;
    }
    this.state.pipesReleased = true;
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
  }

  private finish(): void {
    if (
      this.resolve === undefined ||
      this.reject === undefined ||
      !this.cleanupFinished ||
      !(this.state.closeObserved || this.state.pipesReleased)
    ) {
      return;
    }
    this.teardown();
    const { resolve, reject } = this;
    this.resolve = undefined;
    this.reject = undefined;
    const result = this.commandResult();
    const failure = this.outcomeFailure(result);
    if (failure !== undefined) {
      reject(failure);
      return;
    }
    resolve(result);
  }

  private outcomeFailure(result: CommandResult): Error | undefined {
    if (this.state.cleanupError !== undefined) {
      this.child?.unref();
      return this.state.cleanupError;
    }
    if (this.state.processError !== undefined) {
      return this.state.processError;
    }
    if (this.state.abortRequested || this.options.signal?.aborted) {
      return new Error(`${this.command} aborted`);
    }
    if (this.outputLimitExceeded !== undefined) {
      return new Error(
        `${this.command} ${this.outputLimitExceeded} exceeded ${this.cap} byte output limit`,
      );
    }
    if (result.code === 0 || this.options.allowFailure) {
      return;
    }
    return new Error(
      `${this.command} ${this.args.join(" ")} failed (${result.code}): ${result.stderr.toString().trim()}`,
    );
  }

  private commandResult(): CommandResult {
    let code = this.state.closeCode ?? 1;
    if (this.state.timedOut) {
      code = TIMEOUT_EXIT_CODE;
    }
    return {
      code,
      stdout: Buffer.concat(this.stdout),
      stderr: Buffer.concat(this.stderr),
    };
  }

  private finishBeforeSpawn(error: Error): void {
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.reject?.(error);
  }

  private clearTimeout(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }

  private teardown(): void {
    this.clearTimeout();
    if (this.pipeRelease !== undefined) {
      clearTimeout(this.pipeRelease);
    }
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.child?.stdout.removeListener("data", this.onStdout);
    this.child?.stderr.removeListener("data", this.onStderr);
    this.child?.stdout.removeListener("error", this.onStreamError);
    this.child?.stderr.removeListener("error", this.onStreamError);
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

async function executeCommand(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  assertProcessPlatform(process.platform, command);
  return await new CommandExecution(command, args, options).execute();
}

export { executeCommand };
