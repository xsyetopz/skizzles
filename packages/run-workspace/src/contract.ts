export type CleanupState = "cleanup-failed" | "deleted" | "preserved";

export interface OwnedChild {
  readonly label: string;
  readonly pid?: number;
  requestStop: () => Promise<void> | void;
  forceStop: () => Promise<void> | void;
  /** Resolves only after the entire scope owned by this adapter has exited. */
  waitForExit: () => Promise<void>;
}

export interface ChildCleanup {
  readonly label: string;
  readonly pid?: number;
  readonly stopped: boolean;
  readonly forced: boolean;
  readonly error?: "EXIT_UNCONFIRMED" | "FORCE_STOP_FAILED";
}

export type CloseFailureCode = "CHILD_UNCONFIRMED" | "CLEANUP_FAILED";

export interface CloseReport {
  readonly state: CleanupState;
  readonly runId: string;
  readonly rootName: string;
  readonly children: readonly ChildCleanup[];
  readonly error?: CloseFailureCode;
}

export interface RunWorkspace {
  readonly signal: AbortSignal;
  path: (...relativeParts: readonly string[]) => string;
  registerChild: (child: OwnedChild) => void;
  preserve: (reason: string) => Promise<void>;
  close: () => Promise<CloseReport>;
}

export interface CreateOptions {
  readonly signal?: AbortSignal;
  readonly handleSignals?: boolean;
  readonly gracefulStopMs?: number;
  readonly forceStopMs?: number;
}

export type SkipReason =
  | "live-owner"
  | "too-young"
  | "preserved"
  | "unknown-owner"
  | "malformed-marker"
  | "unmarked"
  | "identity-mismatch"
  | "claimed"
  | "scan-limit";

export interface CleanupSkip {
  readonly rootName: string;
  readonly reason: SkipReason;
}

export interface CleanupFailure {
  readonly rootName: string;
  readonly error: "CLEANUP_FAILED";
}

export interface CleanupReport {
  readonly deleted: readonly string[];
  readonly skipped: readonly CleanupSkip[];
  readonly failed: readonly CleanupFailure[];
  readonly truncated: boolean;
}

export interface CleanupStaleOptions {
  readonly minimumAgeMs?: number;
  readonly scanLimit?: number;
}
