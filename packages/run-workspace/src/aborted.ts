import { RunWorkspaceError } from "./errors.ts";

export class RunWorkspaceAbortedError extends RunWorkspaceError {
  constructor(message = "Run workspace creation was aborted") {
    super("RUN_WORKSPACE_ABORTED", message);
    this.name = "RunWorkspaceAbortedError";
  }
}
