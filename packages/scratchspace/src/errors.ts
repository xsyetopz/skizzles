export type RunWorkspaceErrorCode =
  | "INITIALIZATION_FAILED"
  | "INVALID_CHILD"
  | "INVALID_OPTION"
  | "INVALID_PATH"
  | "INVALID_REASON"
  | "MALFORMED_MARKER"
  | "ROOT_IDENTITY_CHANGED"
  | "RUN_WORKSPACE_ABORTED"
  | "UNKNOWN_PROCESS_IDENTITY"
  | "UNSAFE_PARENT"
  | "UNSAFE_ROOT"
  | "UNVERIFIED_ROOT"
  | "WORKSPACE_CLOSED";

export class RunWorkspaceError extends Error {
  readonly code: RunWorkspaceErrorCode;

  constructor(
    code: RunWorkspaceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunWorkspaceError";
    this.code = code;
  }
}
