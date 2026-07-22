import type { DiscoverySnapshot } from "../../state/discovery.ts";
import type { ExecutionSession } from "../../state/execution.ts";
import type { TargetBaseline } from "../../state/target.ts";
import type {
  CausalWorkflowConfig,
  WorkflowFailureCode,
} from "../causal/contract.ts";
import type { WorkflowLifecycle } from "../lifecycle.ts";
import type { PrepareInput } from "../prepare-input.ts";
import type { PreparedPublication } from "../publication.ts";

export async function prepareWorkflowApproval(
  config: CausalWorkflowConfig,
  parsed: PrepareInput,
  baseline: TargetBaseline,
  discovery: DiscoverySnapshot,
  prepared: PreparedPublication,
  execution: ExecutionSession,
  lifecycle: WorkflowLifecycle,
) {
  const planned = config.orchestrator.planApproval({
    ...config.approvalContext,
    request: parsed.request,
    repository: parsed.repository,
    baseline,
    discovery,
    transactionDigest: prepared.transactionDigest,
    diffBytes: prepared.diffBytes,
  });
  if (planned.status !== "accepted") return rejected("APPROVAL_REJECTED");
  lifecycle.ownApproval(planned.approval);
  const reviewed = config.orchestrator.reviewApproval({
    approval: planned.approval,
  });
  if (reviewed.status !== "accepted") return rejected("APPROVAL_REJECTED");
  lifecycle.updateApproval(reviewed.approval);
  const awaiting = config.orchestrator.awaitApproval({
    approval: reviewed.approval,
  });
  if (awaiting.status !== "accepted") return rejected("APPROVAL_REJECTED");
  lifecycle.updateApproval(awaiting.approval);
  const completion = await config.orchestrator.completeExecution({ execution });
  if (completion.status !== "completed") {
    return rejected("COMPLETION_CONTRACT_REJECTED");
  }
  return Object.freeze({
    status: "awaiting" as const,
    approval: awaiting.approval,
  });
}

function rejected(
  code: Extract<
    WorkflowFailureCode,
    "APPROVAL_REJECTED" | "COMPLETION_CONTRACT_REJECTED"
  >,
) {
  return Object.freeze({ status: "rejected" as const, code });
}
