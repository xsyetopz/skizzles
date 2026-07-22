import { exactKeys, isRecord } from "../codec.ts";
import { isNormalizedRequest, type NormalizedRequest } from "../intent.ts";
import { isRepositoryContext, type RepositoryContext } from "../repository.ts";
import type { Orchestrator } from "../runtime.ts";
import { isTargetBaseline, type TargetBaseline } from "../state/target.ts";
import type { CommandAuditProfile } from "./contract.ts";
import {
  isWorkflowEvidence,
  type WorkflowEngineeringEvidence,
} from "./evidence.ts";
import { parseWorkflowTargets, type WorkflowTarget } from "./publication.ts";

export interface PrepareInput {
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly targets: readonly WorkflowTarget[];
  readonly discoveryRoot: string;
  readonly commands: readonly string[];
  readonly engineeringEvidence: WorkflowEngineeringEvidence | null;
  readonly baseline: TargetBaseline | null;
}

export function parsePrepareInput(
  input: unknown,
  profiles: readonly CommandAuditProfile[],
): PrepareInput | undefined {
  if (
    !(
      isRecord(input) &&
      exactKeys(
        input,
        ["request", "repository", "targets", "discoveryRoot", "commands"],
        ["baseline", "engineeringEvidence"],
      ) &&
      isNormalizedRequest(input["request"]) &&
      isRepositoryContext(input["repository"]) &&
      input["request"].intentDigest === input["repository"].requestDigest &&
      typeof input["discoveryRoot"] === "string"
    )
  ) {
    return;
  }
  const targets = parseWorkflowTargets(input["targets"]);
  const engineeringEvidence = input["engineeringEvidence"];
  const baseline = input["baseline"];
  if (
    targets === undefined ||
    !Array.isArray(input["commands"]) ||
    input["commands"].length === 0 ||
    input["commands"].length > 64 ||
    (engineeringEvidence !== undefined &&
      !isWorkflowEvidence(engineeringEvidence)) ||
    (baseline !== undefined && !isTargetBaseline(baseline))
  ) {
    return;
  }
  const commands: string[] = [];
  for (const command of input["commands"]) {
    if (
      typeof command !== "string" ||
      !profiles.some((profile) => profile.id === command)
    ) {
      return;
    }
    commands.push(command);
  }
  return {
    request: input["request"],
    repository: input["repository"],
    targets,
    discoveryRoot: input["discoveryRoot"],
    commands: Object.freeze(commands),
    engineeringEvidence: engineeringEvidence ?? null,
    baseline: baseline ?? null,
  };
}

export async function acceptPreparedBaseline(
  orchestrator: Orchestrator,
  baseline: TargetBaseline,
  requestDigest: string,
  repositoryId: string,
  treeDigest: string,
  targets: readonly string[],
): Promise<
  | { readonly status: "accepted"; readonly baseline: TargetBaseline }
  | { readonly status: "rejected" }
> {
  if (
    baseline.requestDigest !== requestDigest ||
    baseline.repositoryId !== repositoryId ||
    baseline.treeDigest !== treeDigest ||
    baseline.targets.length !== targets.length ||
    baseline.targets.some((target, index) => target !== targets[index])
  ) {
    return { status: "rejected" };
  }
  const result = await orchestrator.revalidateTargetBaseline(baseline);
  if (result.status !== "unchanged") return { status: "rejected" };
  return { status: "accepted", baseline };
}
