import type {
  TaskWorktreePrepareTerminalResult,
  TaskWorktreeReceipt,
  TaskWorktreeSession,
} from "@skizzles/task-worktree";
import type { RecoveryResult } from "@skizzles/workspace-transaction";
import type { NormalizedRequest } from "../intent.ts";
import type { RepositoryContext } from "../repository.ts";
import type { TargetBaseline } from "../state/target.ts";
import type { TerminalPublication, WorkflowReview } from "./contract.ts";
import type { WorkflowEngineeringEvidence } from "./evidence.ts";
import type { WorkflowLifecycle } from "./lifecycle.ts";
import type { PreparedPublication } from "./publication.ts";
import type { TaskWorktreeApprovalRegistration } from "./worktree/approval.ts";

export type WorkflowRecordState =
  | "awaiting"
  | "approving"
  | "publishing"
  | "recovery"
  | "cleanup-pending"
  | "closed";

export interface WorkflowRecord {
  readonly lifecycle: WorkflowLifecycle;
  readonly taskSession: TaskWorktreeSession;
  readonly taskApprovalRegistration: TaskWorktreeApprovalRegistration;
  readonly baseline: TargetBaseline;
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly prepared: PreparedPublication;
  readonly engineeringEvidence: WorkflowEngineeringEvidence | null;
  readonly preparedTaskReceipt: TaskWorktreeReceipt;
  commitReceipt: TaskWorktreeReceipt | null;
  review: WorkflowReview;
  state: WorkflowRecordState;
  publication: TerminalPublication | null;
  recovery: Extract<RecoveryResult, { readonly ok: true }> | null;
}

export interface CleanupRecord {
  readonly lifecycle: WorkflowLifecycle;
  readonly taskApprovalRegistration?: TaskWorktreeApprovalRegistration;
  state: WorkflowRecordState;
  publication: TerminalPublication | null;
  recovery: Extract<RecoveryResult, { readonly ok: true }> | null;
  readonly deferredPreparation?: TaskWorktreePrepareTerminalResult;
}
