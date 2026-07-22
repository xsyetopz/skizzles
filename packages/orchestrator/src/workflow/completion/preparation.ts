import type { TaskWorktreePrepareTerminalResult } from "@skizzles/task-worktree";
import type {
  WorkflowCleanupReceipt,
  WorkflowPrepareResult,
} from "../contract.ts";

export function preparationResult(
  outcome: TaskWorktreePrepareTerminalResult,
  cleanup: WorkflowCleanupReceipt,
):
  | Extract<
      WorkflowPrepareResult,
      { status: "split-required" | "intervention-required" }
    >
  | Readonly<{
      status: "rejected";
      code: "TASK_WORKTREE_REJECTED";
      cleanup: WorkflowCleanupReceipt;
    }> {
  if (outcome.status === "split-required") {
    return {
      status: "split-required",
      code: "TASK_SPLIT_REQUIRED",
      plan: outcome.plan,
      cleanup,
    };
  }
  if (outcome.status === "intervention-required") {
    return {
      status: "intervention-required",
      code: "TASK_INTERVENTION_REQUIRED",
      diagnostics: outcome.diagnostics,
      cleanup,
    };
  }
  return {
    status: "rejected",
    code: "TASK_WORKTREE_REJECTED",
    cleanup,
  };
}
