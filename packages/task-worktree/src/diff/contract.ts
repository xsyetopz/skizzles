import type { TaskWorktreeDigest } from "../digest.ts";

export interface TaskWorktreeFileState {
  readonly path: string;
  readonly bytes: readonly number[];
}

export interface ExactWorktreeDiffInput {
  readonly baseline: readonly TaskWorktreeFileState[];
  readonly candidate: readonly TaskWorktreeFileState[];
}

export interface DiffCeilings {
  readonly maxChangedFiles: number;
  readonly maxAddedLines: number;
  readonly maxDeletedLines: number;
  readonly maxChangedBytes: number;
}

export type WorktreeChangeKind = "added" | "deleted" | "modified";

export interface ExactWorktreeChange {
  readonly path: string;
  readonly kind: WorktreeChangeKind;
  readonly baselineDigest: TaskWorktreeDigest | null;
  readonly candidateDigest: TaskWorktreeDigest | null;
  readonly baselineBytes: number;
  readonly candidateBytes: number;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly binary: boolean;
}

export interface ExactWorktreeDiffMetrics {
  readonly changedFiles: number;
  readonly addedFiles: number;
  readonly deletedFiles: number;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly baselineBytes: number;
  readonly candidateBytes: number;
  readonly changedBytes: number;
}

export interface TaskWorktreeDiffReceipt {
  readonly baselineDigest: TaskWorktreeDigest;
  readonly candidateDigest: TaskWorktreeDigest;
  readonly diffDigest: TaskWorktreeDigest;
  readonly metrics: ExactWorktreeDiffMetrics;
  readonly changes: readonly ExactWorktreeChange[];
  readonly receiptDigest: TaskWorktreeDigest;
}

export interface TaskWorktreeSlice {
  readonly id: string;
  readonly paths: readonly string[];
  readonly changeDigests: readonly TaskWorktreeDigest[];
  readonly metrics: ExactWorktreeDiffMetrics;
  readonly sliceDigest: TaskWorktreeDigest;
}

export interface TaskWorktreeSplitPlan {
  readonly receiptDigest: TaskWorktreeDigest;
  readonly slices: readonly TaskWorktreeSlice[];
  readonly planDigest: TaskWorktreeDigest;
}

export type DiffAssessmentResult =
  | Readonly<{
      status: "accepted";
      receipt: TaskWorktreeDiffReceipt;
      plan: TaskWorktreeSplitPlan;
    }>
  | Readonly<{
      status: "split-required";
      receipt: TaskWorktreeDiffReceipt;
      plan: TaskWorktreeSplitPlan;
    }>
  | Readonly<{
      status: "rejected";
      code:
        | "INVALID_DIFF_POLICY"
        | "INVALID_EXACT_INPUT"
        | "UNSPLITTABLE_CHANGE";
    }>;

export interface TaskWorktreeDiffAuthority {
  readonly inspect: (input: unknown) => DiffAssessmentResult;
  readonly verify: (input: unknown) => boolean;
}

export type TaskWorktreeDiffAuthorityCreationResult =
  | Readonly<{ status: "created"; authority: TaskWorktreeDiffAuthority }>
  | Readonly<{ status: "rejected"; code: "INVALID_DIFF_POLICY" }>;
