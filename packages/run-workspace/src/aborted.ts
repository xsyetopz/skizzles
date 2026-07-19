import { RunWorkspaceError } from "./errors.ts";

export type RunWorkspaceHandledSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export class RunWorkspaceAbortedError extends RunWorkspaceError {
  readonly signal: RunWorkspaceHandledSignal | undefined;

  constructor(
    message = "Run workspace creation was aborted",
    signal?: RunWorkspaceHandledSignal,
  ) {
    super("RUN_WORKSPACE_ABORTED", message);
    this.name = "RunWorkspaceAbortedError";
    this.signal = signal;
  }
}
