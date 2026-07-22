import {
  isNormalizedRequest,
  type NormalizedRequest,
} from "../admission/intent.ts";
import {
  isRepositoryContext,
  type RepositoryContext,
} from "../admission/repository.ts";
import { exactKeys, isRecord } from "../codec.ts";
import type { Digest } from "../digest.ts";
import type { Orchestrator } from "../runtime.ts";
import { isTargetBaseline, type TargetBaseline } from "../state/target.ts";
import {
  isWorkflowEvidenceDraft,
  type WorkflowEngineeringEvidenceDraft,
} from "./evidence.ts";
import { parseWorkflowTargets, type WorkflowTarget } from "./publication.ts";

export interface PrepareInput {
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly targets: readonly WorkflowTarget[];
  readonly discoveryRoot: string;
  readonly profileIds: readonly string[];
  readonly engineeringEvidenceDraft: WorkflowEngineeringEvidenceDraft;
  readonly baseline: TargetBaseline | null;
  readonly taskEpochDigest: Digest | null;
}

export function parsePrepareInput(input: unknown): PrepareInput | undefined {
  if (
    !(
      isRecord(input) &&
      exactKeys(
        input,
        [
          "request",
          "repository",
          "targets",
          "discoveryRoot",
          "profileIds",
          "engineeringEvidenceDraft",
        ],
        ["baseline", "taskEpochDigest"],
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
  const engineeringEvidenceDraft = input["engineeringEvidenceDraft"];
  const baseline = input["baseline"];
  const taskEpochDigest = input["taskEpochDigest"];
  if (
    targets === undefined ||
    !Array.isArray(input["profileIds"]) ||
    input["profileIds"].length === 0 ||
    input["profileIds"].length > 64 ||
    !isWorkflowEvidenceDraft(engineeringEvidenceDraft) ||
    (baseline !== undefined && !isTargetBaseline(baseline)) ||
    (taskEpochDigest !== undefined && !isDigest(taskEpochDigest))
  ) {
    return;
  }
  const profileIds: string[] = [];
  for (const profileId of input["profileIds"]) {
    if (
      typeof profileId !== "string" ||
      profileId.length === 0 ||
      profileId.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(profileId) ||
      profileIds.includes(profileId)
    ) {
      return;
    }
    profileIds.push(profileId);
  }
  return {
    request: input["request"],
    repository: input["repository"],
    targets,
    discoveryRoot: input["discoveryRoot"],
    profileIds: Object.freeze(profileIds),
    engineeringEvidenceDraft,
    baseline: baseline ?? null,
    taskEpochDigest: taskEpochDigest ?? null,
  };
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
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
