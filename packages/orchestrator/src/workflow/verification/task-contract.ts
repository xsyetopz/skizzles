import type {
  TaskWorktreeVerificationObjective,
  TaskWorktreeVerificationReceipt,
} from "@skizzles/task-worktree";
import type { Digest } from "../../digest.ts";

export interface WorkflowVerificationProfileIds {
  readonly originalTests: string;
  readonly mutation: string;
  readonly property: string;
  readonly coverage: string;
}

export interface WorkflowTaskVerificationBindings {
  readonly taskId: string;
  readonly taskEpochDigest: Digest;
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: Digest;
  readonly baselineDigest: Digest;
}

export interface WorkflowVerificationObjectives {
  readonly originalTests: Extract<
    TaskWorktreeVerificationObjective,
    { readonly kind: "original-tests" }
  >;
  readonly mutation: Extract<
    TaskWorktreeVerificationObjective,
    { readonly kind: "mutation" }
  >;
  readonly property: Extract<
    TaskWorktreeVerificationObjective,
    { readonly kind: "property" }
  >;
  readonly coverage: Extract<
    TaskWorktreeVerificationObjective,
    { readonly kind: "coverage" }
  >;
}

export interface WorkflowTaskVerificationReceipts {
  readonly originalTests: TaskWorktreeVerificationReceipt;
  readonly mutation: TaskWorktreeVerificationReceipt;
  readonly property: TaskWorktreeVerificationReceipt;
  readonly coverage: TaskWorktreeVerificationReceipt;
  readonly ordered: readonly TaskWorktreeVerificationReceipt[];
  readonly objectives: WorkflowVerificationObjectives;
}
