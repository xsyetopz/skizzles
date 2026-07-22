import type {
  RunWorkspace,
  WorkspaceUsageLimits,
} from "@skizzles/run-workspace";
import type { Orchestrator } from "../runtime.ts";
import type { ExecutionSession } from "../state/execution.ts";
import { observeProfile } from "./command/audit.ts";
import { createCommandScope, verifyCommandScope } from "./command/scope.ts";
import type { CommandAuditProfile, WorkflowReview } from "./contract.ts";
import type { WorkflowTarget } from "./publication.ts";

export interface CandidateRun {
  readonly execution: ExecutionSession;
  readonly audits: WorkflowReview["commandAudits"] | null;
}

export async function runWorkflowCommands(input: {
  readonly orchestrator: Orchestrator;
  readonly profiles: readonly CommandAuditProfile[];
  readonly workspace: RunWorkspace;
  readonly limits: WorkspaceUsageLimits;
  readonly repositoryRoot: string;
  readonly targets: readonly WorkflowTarget[];
  readonly commands: readonly string[];
  readonly execution: ExecutionSession;
}): Promise<CandidateRun> {
  let execution = input.execution;
  const audits: WorkflowReview["commandAudits"][number][] = [];
  const dependencyPackages = Object.freeze(
    [
      ...new Set(
        input.commands.flatMap(
          (id) =>
            input.profiles.find((profile) => profile.id === id)
              ?.dependencyPackages ?? [],
        ),
      ),
    ].sort((left, right) => left.localeCompare(right)),
  );
  const scope = await createCommandScope({
    workspace: input.workspace,
    sequence: 0,
    repositoryRoot: input.repositoryRoot,
    limits: input.limits,
    targets: input.targets,
    dependencyPackages,
  });
  if (scope === undefined) return { execution, audits: null };
  for (const id of input.commands) {
    if (!(await workspaceWithinQuota(input.workspace, input.limits))) {
      return { execution, audits: null };
    }
    const profile = input.profiles.find((candidate) => candidate.id === id);
    if (profile === undefined) return { execution, audits: null };
    const action = input.orchestrator.recordExecution({
      execution,
      kind: "action",
    });
    if (action.status !== "accepted") return { execution, audits: null };
    execution = action.execution;
    if (!(await verifyCommandScope(scope))) {
      return { execution, audits: null };
    }
    const audit = await observeProfile(
      profile,
      input.workspace,
      scope.cwd,
      scope.receipt,
    );
    if (
      audit === undefined ||
      !(await workspaceWithinQuota(input.workspace, input.limits)) ||
      !(await verifyCommandScope(scope))
    ) {
      return { execution, audits: null };
    }
    audits.push(audit);
  }
  return { execution, audits: Object.freeze(audits) };
}

export async function workspaceWithinQuota(
  workspace: RunWorkspace,
  limits: WorkspaceUsageLimits,
): Promise<boolean> {
  try {
    const usage = await workspace.inspectUsage(limits);
    return usage.state === "within";
  } catch {
    return false;
  }
}
