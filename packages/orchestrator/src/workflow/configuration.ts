import type {
  CrashInjectionPort,
  DestinationAuthorityPort,
  RepositoryLeaseAuthorityPort,
} from "@skizzles/workspace-transaction";
import { exactKeys, isRecord, nonempty } from "../codec.ts";
import type { Orchestrator } from "../runtime.ts";
import type {
  CausalWorkflowConfig,
  CommandAuditProfile,
  PublicationBaselineAuthorityPort,
  PublicationIdentity,
} from "./contract.ts";

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
        "transaction",
        "workspaceUsageLimits",
        "commandProfiles",
        "approvalContext",
      ]) &&
      isWorkflowOrchestrator(value["orchestrator"]) &&
      isBaselineAuthority(value["baselineAuthority"]) &&
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
  const workspaceUsageLimits = parseUsageLimits(value["workspaceUsageLimits"]);
  const commandProfiles = parseProfiles(value["commandProfiles"]);
  const approvalContext = parseApprovalContext(value["approvalContext"]);
  if (
    publicationIdentity === undefined ||
    workspaceUsageLimits === undefined ||
    commandProfiles === undefined ||
    approvalContext === undefined
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
    transaction: Object.freeze({
      destination,
      leases,
      ...(crashInjection === undefined ? {} : { crashInjection }),
    }),
    workspaceUsageLimits,
    commandProfiles,
    approvalContext,
  });
}

function parseProfiles(
  value: unknown,
): readonly CommandAuditProfile[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return;
  const profiles: CommandAuditProfile[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const parsed = parseProfile(candidate);
    if (parsed === undefined || ids.has(parsed.id)) return;
    ids.add(parsed.id);
    profiles.push(parsed);
  }
  return Object.freeze(profiles);
}

function parseProfile(value: unknown): CommandAuditProfile | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(
        value,
        [
          "id",
          "argv",
          "env",
          "timeoutMilliseconds",
          "maximumOutputBytes",
          "drainMilliseconds",
          "signalGraceMilliseconds",
          "allowedExitCodes",
          "stderr",
        ],
        ["dependencyPackages"],
      ) &&
      validId(value["id"], 128) &&
      value["stderr"] !== undefined &&
      (value["stderr"] === "evidence" || value["stderr"] === "must-be-empty")
    )
  ) {
    return;
  }
  const argv = stringList(value["argv"], 1, 256);
  const env = environment(value["env"]);
  const allowedExitCodes = integerList(value["allowedExitCodes"], 0, 255);
  const dependencyPackages =
    value["dependencyPackages"] === undefined
      ? Object.freeze([])
      : packageList(value["dependencyPackages"]);
  if (
    argv === undefined ||
    env === undefined ||
    allowedExitCodes === undefined ||
    dependencyPackages === undefined ||
    !boundedInteger(value["timeoutMilliseconds"], 1, 3_600_000) ||
    !boundedInteger(value["maximumOutputBytes"], 1, 64 * 1024 * 1024) ||
    !boundedInteger(value["drainMilliseconds"], 0, 60_000) ||
    !boundedInteger(value["signalGraceMilliseconds"], 0, 60_000)
  ) {
    return;
  }
  return Object.freeze({
    id: value["id"],
    argv,
    env,
    dependencyPackages,
    timeoutMilliseconds: value["timeoutMilliseconds"],
    maximumOutputBytes: value["maximumOutputBytes"],
    drainMilliseconds: value["drainMilliseconds"],
    signalGraceMilliseconds: value["signalGraceMilliseconds"],
    allowedExitCodes,
    stderr: value["stderr"],
  });
}

function packageList(value: unknown): readonly string[] | undefined {
  const values = stringList(value, 0, 256);
  if (values === undefined) return;
  const names = new Set<string>();
  for (const name of values) {
    if (
      !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(
        name,
      ) ||
      names.has(name)
    ) {
      return;
    }
    names.add(name);
  }
  return Object.freeze(
    [...names].sort((left, right) => left.localeCompare(right)),
  );
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

function parseUsageLimits(
  value: unknown,
): CausalWorkflowConfig["workspaceUsageLimits"] | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, ["byteLimit", "entryLimit", "scanLimit"])
    )
  )
    return;
  if (
    !(
      boundedInteger(value["byteLimit"], 1, Number.MAX_SAFE_INTEGER) &&
      boundedInteger(value["entryLimit"], 1, Number.MAX_SAFE_INTEGER) &&
      boundedInteger(value["scanLimit"], 1, 1_000_000)
    )
  )
    return;
  return Object.freeze({
    byteLimit: value["byteLimit"],
    entryLimit: value["entryLimit"],
    scanLimit: value["scanLimit"],
  });
}

function stringList(
  value: unknown,
  minimum: number,
  maximum: number,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    return;
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 32_768 ||
      item.includes("\0")
    )
      return;
    result.push(item);
  }
  return Object.freeze(result);
}

function integerList(
  value: unknown,
  minimum: number,
  maximum: number,
): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return;
  const result: number[] = [];
  for (const item of value) {
    if (!boundedInteger(item, minimum, maximum) || result.includes(item))
      return;
    result.push(item);
  }
  return Object.freeze(result.sort((left, right) => left - right));
}

function environment(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value) || Object.keys(value).length > 256) return;
  const result: Record<string, string> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      typeof entry !== "string" ||
      entry.includes("\0")
    )
      return;
    result[key] = entry;
  }
  return Object.freeze(result);
}

function validId(value: unknown, maximum: number): value is string {
  return nonempty(value, maximum) && idPattern.test(value);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
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
