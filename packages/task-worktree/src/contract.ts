import type { CommitSynthesisPolicy } from "./commit/contract.ts";
import type { DependencyResolutionRequest } from "./dependency/resolution.ts";
import type { DiffCeilings, TaskWorktreeSplitPlan } from "./diff/contract.ts";
import type { TaskWorktreeDigest } from "./digest.ts";
import type { SandboxAuthorityExecutionRequest } from "./sandbox/capabilities.ts";
import type { CommandProfile } from "./sandbox/command-policy.ts";

export type { TaskWorktreeDigest } from "./digest.ts";
export { digestTaskWorktreeBytes, digestTaskWorktreeValue } from "./digest.ts";

export type TaskWorktreeOperation = "delete" | "write";

export interface TaskWorktreeChange {
  readonly path: string;
  readonly operation: TaskWorktreeOperation;
  readonly baselineDigest: TaskWorktreeDigest | null;
  readonly candidateBytes: readonly number[] | null;
}

export interface TaskWorktreePrepareInput {
  readonly taskId: string;
  readonly requestDigest: TaskWorktreeDigest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: TaskWorktreeDigest;
  readonly baselineDigest: TaskWorktreeDigest;
  readonly changes: readonly TaskWorktreeChange[];
}

export interface TaskWorktreeActionInput {
  readonly version: 1;
  readonly session: TaskWorktreeSession;
}

export interface TaskWorktreeConfig {
  readonly authorityId: string;
  readonly repositoryRoot: string;
  readonly worktreeParent: string;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly approvalAuthority: Readonly<{
    id: string;
    authorize: (
      request: TaskWorktreeApprovalAuthorityRequest,
    ) => unknown | Promise<unknown>;
  }>;
  readonly diffCeilings: DiffCeilings;
  readonly commitPolicy: CommitSynthesisPolicy;
  readonly sandbox: Readonly<{
    id: string;
    attest: (paths: readonly string[]) => unknown | Promise<unknown>;
    execute: (
      request: SandboxAuthorityExecutionRequest,
    ) => unknown | Promise<unknown>;
  }>;
  readonly sandboxWritePaths: readonly string[];
  readonly dependencyResolver: Readonly<{
    id: string;
    resolve: (
      request: DependencyResolutionRequest,
    ) => unknown | Promise<unknown>;
  }>;
  readonly dependencyRequests: readonly DependencyResolutionRequest[];
  readonly commandProfiles: readonly TaskWorktreeCommandProfile[];
}

export interface TaskWorktreeCommandProfile {
  readonly id: string;
  readonly profile: CommandProfile;
  readonly executable: "bun" | "git";
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
  readonly drainMilliseconds: number;
  readonly signalGraceMilliseconds: number;
}

export interface TaskWorktreeReceipt {
  readonly schema: "skizzles.task-worktree/receipt";
  readonly authorityId: string;
  readonly taskId: string;
  readonly branchName: string;
  readonly baseCommitDigest: TaskWorktreeDigest;
  readonly declaredPathDigest: TaskWorktreeDigest;
  readonly candidateDigest: TaskWorktreeDigest;
  readonly diff: Readonly<{
    digest: TaskWorktreeDigest;
    changedFiles: number;
    addedLines: number;
    deletedLines: number;
    binaryFiles: number;
  }>;
  readonly sandbox: Readonly<{
    mechanism: string;
    policyDigest: TaskWorktreeDigest;
  }>;
  readonly dependencies: Readonly<{
    digest: TaskWorktreeDigest;
    warningCount: number;
  }>;
  readonly commitPlan: Readonly<{
    type: string;
    scope: string;
    subject: string;
    messageDigest: TaskWorktreeDigest;
    planDigest: TaskWorktreeDigest;
  }>;
  readonly phasePlanDigest: TaskWorktreeDigest;
  readonly receiptDigest: TaskWorktreeDigest;
}

export type TaskWorktreeReceiptSummary = Omit<
  TaskWorktreeReceipt,
  "receiptDigest" | "schema"
>;

export interface TaskWorktreeSession {
  readonly schema: "skizzles.task-worktree/session";
}

export interface TaskWorktreeCleanupHandle {
  readonly schema: "skizzles.task-worktree/cleanup-handle";
}

export interface TaskWorktree {
  readonly prepare: (input: unknown) => Promise<TaskWorktreePrepareResult>;
  readonly retryCleanup: (input: unknown) => Promise<TaskWorktreeCleanupResult>;
  readonly run: (input: unknown) => Promise<TaskWorktreeRunResult>;
  readonly revalidate: (
    input: unknown,
  ) => Promise<TaskWorktreeRevalidationResult>;
  readonly authorize: (
    input: unknown,
  ) => Promise<TaskWorktreeAuthorizationResult>;
  readonly commit: (input: unknown) => Promise<TaskWorktreeCommitResult>;
  readonly close: (input: unknown) => Promise<TaskWorktreeCloseResult>;
}

export interface TaskWorktreeApprovalBinding {
  readonly authorityId: string;
  readonly taskId: string;
  readonly requestDigest: TaskWorktreeDigest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: TaskWorktreeDigest;
  readonly baselineDigest: TaskWorktreeDigest;
  readonly preparationDigest: TaskWorktreeDigest;
  readonly candidateDigest: TaskWorktreeDigest;
  readonly diffDigest: TaskWorktreeDigest;
  readonly revalidationDigest: TaskWorktreeDigest;
  readonly commitPlanDigest: TaskWorktreeDigest;
  readonly runDigest: TaskWorktreeDigest;
  readonly runProfileIds: readonly string[];
  readonly runOutcomeDigests: readonly string[];
  readonly runReceiptDigest: TaskWorktreeDigest;
  readonly bindingDigest: TaskWorktreeDigest;
}

export interface TaskWorktreeApprovalAuthorityRequest {
  readonly authorityId: string;
  readonly binding: TaskWorktreeApprovalBinding;
  readonly approvalEvidence: unknown;
}

export interface TaskWorktreePromotionPermit {
  readonly schema: "skizzles.task-worktree/promotion-permit";
  readonly permitDigest: TaskWorktreeDigest;
}

export type TaskWorktreeFailureCode =
  | "ALREADY_PREPARED"
  | "APPROVAL_REJECTED"
  | "BRANCH_COLLISION"
  | "BASELINE_MISMATCH"
  | "CANDIDATE_REJECTED"
  | "CLEANUP_INCOMPLETE"
  | "COMMAND_FAILED"
  | "COMMIT_REJECTED"
  | "DEPENDENCY_INTERVENTION_REQUIRED"
  | "DIFF_REJECTED"
  | "DIFF_SPLIT_REQUIRED"
  | "DIRTY_REPOSITORY"
  | "DIRTY_WORKTREE"
  | "HEAD_MISMATCH"
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "LIFECYCLE_CLOSED"
  | "REPOSITORY_MISMATCH"
  | "SESSION_MISMATCH"
  | "SANDBOX_REJECTED"
  | "SYMLINK_REJECTED"
  | "TREE_MISMATCH"
  | "WORKTREE_COLLISION";

export type TaskWorktreeCreationResult =
  | Readonly<{ status: "created"; taskWorktree: TaskWorktree }>
  | Readonly<{ status: "rejected"; code: "INVALID_CONFIG" }>;

export type TaskWorktreePrepareTerminalResult =
  | Readonly<{
      status: "split-required";
      plan: TaskWorktreeSplitPlan;
    }>
  | Readonly<{
      status: "intervention-required";
      diagnostics: readonly Readonly<{
        kind: "dependency";
        request: Readonly<{
          ecosystem: "npm";
          name: string;
          requestedRange: string;
        }> | null;
        outcome: "mismatch" | "rejected" | "unavailable";
        code: string | null;
        warning: string | null;
        receiptDigest: string | null;
      }>[];
    }>
  | Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }>;

export type TaskWorktreeCleanupPendingResult = Readonly<{
  status: "cleanup-pending";
  code: "CLEANUP_INCOMPLETE";
  handle: TaskWorktreeCleanupHandle;
  outcome: TaskWorktreePrepareTerminalResult;
}>;

export type TaskWorktreePrepareResult =
  | Readonly<{
      status: "prepared";
      session: TaskWorktreeSession;
      receipt: TaskWorktreeReceipt;
    }>
  | TaskWorktreePrepareTerminalResult
  | TaskWorktreeCleanupPendingResult;

export type TaskWorktreeCleanupResult =
  | Readonly<{
      status: "cleaned";
      outcome: TaskWorktreePrepareTerminalResult;
    }>
  | TaskWorktreeCleanupPendingResult
  | Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }>;

export type TaskWorktreeCloseResult =
  | Readonly<{ status: "closed"; receipt: TaskWorktreeReceipt }>
  | Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }>;

export type TaskWorktreeRunResult =
  | Readonly<{ status: "ran"; receipt: TaskWorktreeReceipt }>
  | Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }>;

export type TaskWorktreeRevalidationResult =
  | Readonly<{ status: "valid"; receipt: TaskWorktreeReceipt }>
  | Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }>;

export type TaskWorktreeCommitResult =
  | Readonly<{ status: "committed"; receipt: TaskWorktreeReceipt }>
  | Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }>;

export type TaskWorktreeAuthorizationResult =
  | Readonly<{
      status: "authorized";
      permit: TaskWorktreePromotionPermit;
    }>
  | Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }>;
