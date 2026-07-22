import {
  isTaskWorktreeReceipt,
  type TaskWorktreePrepareTerminalResult,
  type TaskWorktreeReceipt,
  type TaskWorktreeSession,
} from "@skizzles/task-worktree";
import type { Digest } from "../../digest.ts";
import type { TargetBaseline } from "../../state/target.ts";
import type {
  CapturedPublicationBaseline,
  CausalWorkflowConfig,
} from "../causal/contract.ts";
import type { WorkflowLifecycle } from "../lifecycle.ts";
import type { PrepareInput } from "../prepare-input.ts";

export type WorkflowTaskPreparation =
  | Readonly<{
      status: "prepared";
      session: TaskWorktreeSession;
      receipt: TaskWorktreeReceipt;
    }>
  | Readonly<{ status: "rejected" }>
  | Readonly<{
      status: "terminal";
      outcome: TaskWorktreePrepareTerminalResult;
    }>;

export async function prepareWorkflowTask(
  config: CausalWorkflowConfig,
  parsed: PrepareInput,
  baseline: TargetBaseline,
  captured: CapturedPublicationBaseline,
  lifecycle: WorkflowLifecycle,
  taskEpochDigest: Digest,
): Promise<WorkflowTaskPreparation> {
  const preparation = await config.taskWorktree.prepare(
    Object.freeze({
      taskId: config.approvalContext.taskId,
      taskEpochDigest,
      requestDigest: parsed.request.intentDigest,
      repositoryId: parsed.repository.repositoryId,
      rootIdentity: config.publicationIdentity.rootIdentity,
      treeDigest: parsed.repository.treeDigest,
      baselineDigest: baseline.baselineDigest,
      changes: Object.freeze(
        parsed.targets.map((target, index) => {
          const expected = captured.targets[index]?.expected;
          return Object.freeze({
            path: target.path,
            operation: target.operation,
            baselineDigest:
              expected?.state === "file"
                ? (`sha256:${expected.contentDigest}` as const)
                : null,
            candidateBytes: target.candidateBytes,
          });
        }),
      ),
    }),
  );
  if (preparation.status === "cleanup-pending") {
    lifecycle.ownTaskWorktreeCleanup(config.taskWorktree, preparation.handle);
    return Object.freeze({
      status: "terminal",
      outcome: preparation.outcome,
    });
  }
  if (preparation.status === "split-required") {
    return Object.freeze({
      status: "terminal",
      outcome: preparation,
    });
  }
  if (preparation.status === "intervention-required") {
    return Object.freeze({
      status: "terminal",
      outcome: preparation,
    });
  }
  if (
    preparation.status !== "prepared" ||
    !isTaskWorktreeReceipt(preparation.receipt)
  ) {
    return Object.freeze({ status: "rejected" });
  }
  lifecycle.ownTaskWorktree(config.taskWorktree, preparation.session);
  return Object.freeze({
    status: "prepared",
    session: preparation.session,
    receipt: preparation.receipt,
  });
}
