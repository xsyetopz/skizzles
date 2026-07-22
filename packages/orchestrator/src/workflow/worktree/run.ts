import {
  isTaskWorktreeReceipt,
  type TaskWorktreeReceipt,
  type TaskWorktreeSession,
} from "@skizzles/task-worktree";
import type { ExecutionSession } from "../../state/execution.ts";
import type {
  CausalWorkflowConfig,
  WorkflowFailureCode,
} from "../causal/contract.ts";

export async function runWorkflowTask(
  config: CausalWorkflowConfig,
  session: TaskWorktreeSession,
  profileIds: readonly string[],
  initialExecution: ExecutionSession,
): Promise<
  | Readonly<{
      status: "ran";
      receipt: TaskWorktreeReceipt;
      execution: ExecutionSession;
    }>
  | Readonly<{
      status: "rejected";
      code: Extract<
        WorkflowFailureCode,
        "EXECUTION_BUDGET_REJECTED" | "TASK_WORKTREE_REJECTED"
      >;
      execution: ExecutionSession;
    }>
> {
  const run = await config.taskWorktree.run(
    Object.freeze({ version: 1 as const, session, profileIds }),
  );
  if (run.status !== "ran" || !isTaskWorktreeReceipt(run.receipt)) {
    return Object.freeze({
      status: "rejected",
      code: "TASK_WORKTREE_REJECTED",
      execution: initialExecution,
    });
  }
  let execution = initialExecution;
  for (const _profileId of profileIds) {
    const recorded = config.orchestrator.recordExecution({
      execution,
      kind: "action",
    });
    if (recorded.status !== "accepted") {
      return Object.freeze({
        status: "rejected",
        code: "EXECUTION_BUDGET_REJECTED",
        execution,
      });
    }
    execution = recorded.execution;
  }
  return Object.freeze({
    status: "ran",
    receipt: run.receipt,
    execution,
  });
}
