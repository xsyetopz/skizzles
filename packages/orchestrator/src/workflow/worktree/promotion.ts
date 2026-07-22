import {
  isTaskWorktreeReceipt,
  type TaskWorktreeReceipt,
  type TaskWorktreeSession,
} from "@skizzles/task-worktree";
import type { PromotionPermit } from "../../state/approval.ts";
import type { TargetBaseline } from "../../state/target.ts";
import type { CausalWorkflowConfig } from "../causal/contract.ts";
import {
  revalidateWorkflowEvidence,
  type WorkflowEngineeringEvidence,
} from "../evidence.ts";
import type { WorkflowVerificationEvidence } from "../verification/contract.ts";
import type {
  WorkflowTaskVerificationBindings,
  WorkflowTaskVerificationReceipts,
  WorkflowVerificationProfileIds,
} from "../verification/task-contract.ts";
import { sameTaskWorktreeBinding } from "./receipt.ts";
import { revalidateWorkflowTaskVerification } from "./verification.ts";

export async function revalidatePromotionState(
  config: CausalWorkflowConfig,
  session: TaskWorktreeSession,
  receipt: TaskWorktreeReceipt,
  baseline: TargetBaseline,
  evidence: WorkflowEngineeringEvidence | null,
  verificationBindings: WorkflowTaskVerificationBindings,
  verificationProfiles: WorkflowVerificationProfileIds,
  taskVerification: WorkflowTaskVerificationReceipts,
  verification: WorkflowVerificationEvidence,
): Promise<
  | "TASK_WORKTREE_REVALIDATION_REJECTED"
  | "APPROVAL_DRIFTED"
  | "ENGINEERING_EVIDENCE_REJECTED"
  | null
> {
  const target = await config.orchestrator.revalidateTargetBaseline(baseline);
  if (target.status !== "unchanged") return "APPROVAL_DRIFTED";
  if (evidence !== null && !(await revalidateWorkflowEvidence(evidence))) {
    return "ENGINEERING_EVIDENCE_REJECTED";
  }
  if (
    !(await revalidateWorkflowTaskVerification({
      taskWorktree: config.taskWorktree,
      session,
      taskReceipt: receipt,
      bindings: verificationBindings,
      profileIds: verificationProfiles,
      receipts: taskVerification,
    })) ||
    (await config.verificationAuthority.verify(verification)).status !== "valid"
  ) {
    return "TASK_WORKTREE_REVALIDATION_REJECTED";
  }
  const worktree = await config.taskWorktree.revalidate(
    Object.freeze({ version: 1 as const, session }),
  );
  if (
    worktree.status !== "valid" ||
    !isTaskWorktreeReceipt(worktree.receipt) ||
    !sameTaskWorktreeBinding(receipt, worktree.receipt)
  ) {
    return "TASK_WORKTREE_REVALIDATION_REJECTED";
  }
  return null;
}

export async function commitWorkflowTask(
  config: CausalWorkflowConfig,
  session: TaskWorktreeSession,
  expected: TaskWorktreeReceipt,
  permit: PromotionPermit,
): Promise<TaskWorktreeReceipt | undefined> {
  const authorization = await config.taskWorktree.authorize(
    Object.freeze({
      version: 1 as const,
      session,
      approvalEvidence: permit,
    }),
  );
  if (authorization.status !== "authorized") return;
  const committed = await config.taskWorktree.commit(
    Object.freeze({
      version: 1 as const,
      session,
      permit: authorization.permit,
    }),
  );
  if (
    committed.status !== "committed" ||
    !isTaskWorktreeReceipt(committed.receipt) ||
    !sameTaskWorktreeBinding(expected, committed.receipt)
  ) {
    return;
  }
  return committed.receipt;
}
