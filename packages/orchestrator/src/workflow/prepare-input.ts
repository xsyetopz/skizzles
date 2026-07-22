import { exactKeys, isRecord } from "../codec.ts";
import { isNormalizedRequest, type NormalizedRequest } from "../intent.ts";
import { isRepositoryContext, type RepositoryContext } from "../repository.ts";
import type { CommandAuditProfile } from "./contract.ts";
import { parseWorkflowTargets, type WorkflowTarget } from "./publication.ts";

export interface PrepareInput {
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly targets: readonly WorkflowTarget[];
  readonly discoveryRoot: string;
  readonly commands: readonly string[];
}

export function parsePrepareInput(
  input: unknown,
  profiles: readonly CommandAuditProfile[],
): PrepareInput | undefined {
  if (
    !(
      isRecord(input) &&
      exactKeys(input, [
        "request",
        "repository",
        "targets",
        "discoveryRoot",
        "commands",
      ]) &&
      isNormalizedRequest(input["request"]) &&
      isRepositoryContext(input["repository"]) &&
      input["request"].intentDigest === input["repository"].requestDigest &&
      typeof input["discoveryRoot"] === "string"
    )
  ) {
    return;
  }
  const targets = parseWorkflowTargets(input["targets"]);
  if (
    targets === undefined ||
    !Array.isArray(input["commands"]) ||
    input["commands"].length === 0 ||
    input["commands"].length > 64
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
  };
}
