export interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowFailure?: boolean;
  maxOutputBytes?: number;
  /** Reject instead of returning a truncated stdout or stderr buffer. */
  rejectOnOutputLimit?: boolean;
  signal?: AbortSignal;
}
