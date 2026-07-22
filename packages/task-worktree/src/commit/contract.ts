import type {
  TaskWorktreeDiffReceipt,
  TaskWorktreeSlice,
} from "../diff/contract.ts";
import type { TaskWorktreeDigest } from "../digest.ts";

export type ConventionalCommitType =
  | "build"
  | "chore"
  | "docs"
  | "feat"
  | "fix"
  | "refactor"
  | "test";

export interface OwnedPackagePath {
  readonly path: string;
  readonly scope: string;
}

export interface CommitSynthesisPolicy {
  readonly ownedPackagePaths: readonly OwnedPackagePath[];
  readonly maxSubjectLength: number;
}

export interface ConventionalCommitMessage {
  readonly type: ConventionalCommitType;
  readonly scope: string;
  readonly description: string;
  readonly trailers: readonly Readonly<{ token: string; value: string }>[];
  readonly text: string;
  readonly messageDigest: TaskWorktreeDigest;
}

export interface AtomicTaskSliceCommitPlan {
  readonly mode: "atomic-task-slice";
  readonly receiptDigest: TaskWorktreeDigest;
  readonly sliceDigest: TaskWorktreeDigest;
  readonly message: ConventionalCommitMessage;
  readonly planDigest: TaskWorktreeDigest;
}

export interface AtomicTaskSliceCommitReceipt {
  readonly plan: AtomicTaskSliceCommitPlan;
  readonly receiptDigest: TaskWorktreeDigest;
}

export interface ApprovedAtomicTaskSliceCommit {
  readonly planDigest: TaskWorktreeDigest;
  readonly approvalDigest: TaskWorktreeDigest;
  readonly authorizationDigest: TaskWorktreeDigest;
}

export type CommitPlanResult =
  | Readonly<{ status: "prepared"; receipt: AtomicTaskSliceCommitReceipt }>
  | Readonly<{
      status: "rejected";
      code:
        | "INVALID_COMMIT_POLICY"
        | "INVALID_DIFF_RECEIPT"
        | "INVALID_TASK_SLICE"
        | "SCOPE_AMBIGUOUS"
        | "MESSAGE_INVALID";
    }>;

export type CommitAuthorizationResult =
  | Readonly<{ status: "authorized"; approval: ApprovedAtomicTaskSliceCommit }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_COMMIT_RECEIPT" | "INVALID_APPROVAL_DIGEST";
    }>;

export interface TaskWorktreeCommitAuthority {
  readonly prepare: (input: unknown) => CommitPlanResult;
  readonly authorize: (input: unknown) => CommitAuthorizationResult;
  readonly verify: (input: unknown) => boolean;
}

export type TaskWorktreeCommitAuthorityCreationResult =
  | Readonly<{ status: "created"; authority: TaskWorktreeCommitAuthority }>
  | Readonly<{ status: "rejected"; code: "INVALID_COMMIT_POLICY" }>;

export type CommitMessageParseResult =
  | Readonly<{ status: "valid"; message: ConventionalCommitMessage }>
  | Readonly<{ status: "invalid"; code: "INVALID_COMMIT_MESSAGE" }>;

export type DiffSliceCommitInput = Readonly<{
  receipt: TaskWorktreeDiffReceipt;
  slice: TaskWorktreeSlice;
}>;
