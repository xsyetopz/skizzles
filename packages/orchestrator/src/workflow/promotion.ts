import type { RunWorkspace } from "@skizzles/run-workspace";
import type { TargetBaseline } from "../state/target.ts";
import { workspaceWithinQuota } from "./candidate-runner.ts";
import type { CausalWorkflowConfig } from "./contract.ts";
import {
  revalidateWorkflowEvidence,
  type WorkflowEngineeringEvidence,
} from "./evidence.ts";

export async function revalidatePromotionState(
  config: CausalWorkflowConfig,
  workspace: RunWorkspace,
  baseline: TargetBaseline,
  evidence: WorkflowEngineeringEvidence | null,
): Promise<
  | "WORKSPACE_QUOTA_REJECTED"
  | "APPROVAL_DRIFTED"
  | "ENGINEERING_EVIDENCE_REJECTED"
  | null
> {
  if (!(await workspaceWithinQuota(workspace, config.workspaceUsageLimits))) {
    return "WORKSPACE_QUOTA_REJECTED";
  }
  const target = await config.orchestrator.revalidateTargetBaseline(baseline);
  if (target.status !== "unchanged") return "APPROVAL_DRIFTED";
  if (evidence !== null && !(await revalidateWorkflowEvidence(evidence))) {
    return "ENGINEERING_EVIDENCE_REJECTED";
  }
  return null;
}
