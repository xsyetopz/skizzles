import { isTaskWorktree } from "@skizzles/task-worktree";
import type {
  CrashInjectionPort,
  DestinationAuthorityPort,
  RepositoryLeaseAuthorityPort,
} from "@skizzles/workspace-transaction";
import { exactKeys, isRecord, nonempty } from "../codec.ts";
import type { Orchestrator } from "../runtime.ts";
import type {
  CausalWorkflowConfig,
  PublicationBaselineAuthorityPort,
  PublicationIdentity,
} from "./contract.ts";
import { isWorkflowVerificationAuthority } from "./verification/authority.ts";
import type { WorkflowVerificationProfileIds } from "./verification/task-contract.ts";
import { isTaskWorktreeApprovalBridge } from "./worktree/approval.ts";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

export function parseWorkflowConfig(
  value: unknown,
): CausalWorkflowConfig | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, [
        "orchestrator",
        "publicationIdentity",
        "baselineAuthority",
        "taskWorktree",
        "taskWorktreeApproval",
        "verificationAuthority",
        "verificationProfiles",
        "transaction",
        "approvalContext",
      ]) &&
      isWorkflowOrchestrator(value["orchestrator"]) &&
      isBaselineAuthority(value["baselineAuthority"]) &&
      isTaskWorktree(value["taskWorktree"]) &&
      isTaskWorktreeApprovalBridge(value["taskWorktreeApproval"]) &&
      isWorkflowVerificationAuthority(value["verificationAuthority"]) &&
      isRecord(value["transaction"]) &&
      exactKeys(
        value["transaction"],
        ["destination", "leases"],
        ["crashInjection"],
      ) &&
      isDestination(value["transaction"]["destination"]) &&
      isLeases(value["transaction"]["leases"]) &&
      (value["transaction"]["crashInjection"] === undefined ||
        isCrashInjection(value["transaction"]["crashInjection"]))
    )
  ) {
    return;
  }
  const publicationIdentity = parseIdentity(value["publicationIdentity"]);
  const approvalContext = parseApprovalContext(value["approvalContext"]);
  const verificationProfiles = parseVerificationProfiles(
    value["verificationProfiles"],
  );
  if (
    publicationIdentity === undefined ||
    approvalContext === undefined ||
    verificationProfiles === undefined
  ) {
    return;
  }
  const transaction = value["transaction"];
  const destination = transaction["destination"];
  const leases = transaction["leases"];
  const crashInjection = transaction["crashInjection"];
  if (
    !(isDestination(destination) && isLeases(leases)) ||
    (crashInjection !== undefined && !isCrashInjection(crashInjection))
  ) {
    return;
  }
  return Object.freeze({
    orchestrator: value["orchestrator"],
    publicationIdentity,
    baselineAuthority: value["baselineAuthority"],
    taskWorktree: value["taskWorktree"],
    taskWorktreeApproval: value["taskWorktreeApproval"],
    verificationAuthority: value["verificationAuthority"],
    verificationProfiles,
    transaction: Object.freeze({
      destination,
      leases,
      ...(crashInjection === undefined ? {} : { crashInjection }),
    }),
    approvalContext,
  });
}

function parseVerificationProfiles(
  value: unknown,
): WorkflowVerificationProfileIds | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, ["originalTests", "mutation", "property", "coverage"])
    )
  ) {
    return;
  }
  const profiles = [
    value["originalTests"],
    value["mutation"],
    value["property"],
    value["coverage"],
  ];
  if (
    profiles.some((profile) => !validId(profile, 128)) ||
    new Set(profiles).size !== profiles.length
  ) {
    return;
  }
  return Object.freeze({
    originalTests: value["originalTests"] as string,
    mutation: value["mutation"] as string,
    property: value["property"] as string,
    coverage: value["coverage"] as string,
  });
}

function parseIdentity(value: unknown): PublicationIdentity | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, ["repositoryId", "rootIdentity", "ownerId"])
    )
  )
    return;
  if (
    !(
      validId(value["repositoryId"], 256) &&
      validId(value["rootIdentity"], 256) &&
      validId(value["ownerId"], 256)
    )
  )
    return;
  return Object.freeze({
    repositoryId: value["repositoryId"],
    rootIdentity: value["rootIdentity"],
    ownerId: value["ownerId"],
  });
}

function parseApprovalContext(
  value: unknown,
): CausalWorkflowConfig["approvalContext"] | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, ["taskId", "principalId", "operation"])
    )
  )
    return;
  if (
    !(
      validId(value["taskId"], 128) &&
      validId(value["principalId"], 128) &&
      validId(value["operation"], 128)
    )
  )
    return;
  return Object.freeze({
    taskId: value["taskId"],
    principalId: value["principalId"],
    operation: value["operation"],
  });
}

function validId(value: unknown, maximum: number): value is string {
  return nonempty(value, maximum) && idPattern.test(value);
}

function isWorkflowOrchestrator(value: unknown): value is Orchestrator {
  return (
    isRecord(value) &&
    [
      "captureTargetBaseline",
      "releaseTargetBaseline",
      "revalidateTargetBaseline",
      "discover",
      "startExecution",
      "recordExecution",
      "completeExecution",
      "planApproval",
      "reviewApproval",
      "awaitApproval",
      "approve",
      "promote",
      "cancelApproval",
    ].every((name) => typeof value[name] === "function")
  );
}

function isBaselineAuthority(
  value: unknown,
): value is PublicationBaselineAuthorityPort {
  return isRecord(value) && typeof value["capture"] === "function";
}

function isDestination(value: unknown): value is DestinationAuthorityPort {
  return (
    isRecord(value) &&
    [
      "captureRepository",
      "inspectTargets",
      "readJournal",
      "writeJournal",
      "removeJournal",
      "createSibling",
      "inspectSibling",
      "removeSibling",
      "replaceTargetFromSibling",
      "retireTargetToSibling",
    ].every((name) => typeof value[name] === "function")
  );
}

function isLeases(value: unknown): value is RepositoryLeaseAuthorityPort {
  return isRecord(value) && typeof value["acquirePublication"] === "function";
}

function isCrashInjection(value: unknown): value is CrashInjectionPort {
  return isRecord(value) && typeof value["checkpoint"] === "function";
}
