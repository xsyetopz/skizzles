import {
  createReflexionFailureRecord,
  type ExternalSkillDirectoryReference,
  isReflexionMemoryQuery,
  isReflexionMemoryRecorder,
} from "@skizzles/reflexion-memory";
import { snapshotArray, snapshotRecord } from "../engineering/snapshot.ts";
import { isEngineeringWorkflow } from "../engineering/workflow.ts";
import { isContextFragment } from "./context/fragment.ts";
import { isOutboundContextMiddleware } from "./context/payload.ts";
import { isSpecificationContextAuthority } from "./context/specification.ts";
import { isAgentlessExecutor } from "./execution/agentless.ts";
import { isReActController } from "./execution/react.ts";
import { isModelDispatchAuthority } from "./model-dispatch.ts";
import type {
  AgentRuntimeConfig,
  AgentRuntimeRunRequest,
} from "./runtime-contract.ts";
import { isDependencyScheduler } from "./scheduler/runtime.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;

export function parseAgentRuntimeConfig(
  input: unknown,
): AgentRuntimeConfig | undefined {
  const value = snapshotRecord(
    input,
    [
      "agentless",
      "engineering",
      "scheduler",
      "context",
      "specifications",
      "memoryQuery",
      "memoryRecorder",
      "modelDispatch",
      "skillReferences",
    ],
    ["react"],
  );
  const react = value?.["react"];
  if (
    value === undefined ||
    !isAgentlessExecutor(value["agentless"]) ||
    !isEngineeringWorkflow(value["engineering"]) ||
    !isDependencyScheduler(value["scheduler"]) ||
    !isOutboundContextMiddleware(value["context"]) ||
    !isSpecificationContextAuthority(value["specifications"]) ||
    !isReflexionMemoryQuery(value["memoryQuery"]) ||
    !isReflexionMemoryRecorder(value["memoryRecorder"]) ||
    !isModelDispatchAuthority(value["modelDispatch"]) ||
    (react !== undefined && !isReActController(react))
  ) {
    return;
  }
  const skillReferences = parseSkillReferences(value["skillReferences"]);
  if (skillReferences === undefined) return;
  return Object.freeze({
    agentless: value["agentless"],
    engineering: value["engineering"],
    ...(react === undefined ? {} : { react }),
    scheduler: value["scheduler"],
    context: value["context"],
    specifications: value["specifications"],
    memoryQuery: value["memoryQuery"],
    memoryRecorder: value["memoryRecorder"],
    modelDispatch: value["modelDispatch"],
    skillReferences,
  });
}

export function parseAgentRuntimeRunRequest(
  input: unknown,
): AgentRuntimeRunRequest | undefined {
  const value = snapshotRecord(
    input,
    [
      "taskId",
      "runId",
      "objectiveDigest",
      "request",
      "repository",
      "targets",
      "validationProfile",
      "changeDeclaration",
      "faultDeclarations",
      "integrations",
      "supportingFragments",
    ],
    ["mode"],
  );
  const fragments = snapshotArray(value?.["supportingFragments"], 256);
  const targets = snapshotArray(value?.["targets"], 256);
  const integrations = snapshotArray(value?.["integrations"], 256);
  const mode = value?.["mode"] ?? "agentless";
  if (
    value === undefined ||
    !validIdentifier(value["taskId"]) ||
    !validIdentifier(value["runId"]) ||
    !validDigest(value["objectiveDigest"]) ||
    fragments === undefined ||
    targets === undefined ||
    targets.length === 0 ||
    targets.some((target) => !validIdentifier(target)) ||
    integrations === undefined ||
    !validIdentifier(value["validationProfile"]) ||
    (mode !== "agentless" && mode !== "react")
  ) {
    return;
  }
  const contextFragments = [];
  for (const fragment of fragments) {
    if (
      !isContextFragment(fragment) ||
      fragment.kind !== "supporting" ||
      fragment.critical
    ) {
      return;
    }
    contextFragments.push(fragment);
  }
  const ids = contextFragments.map((fragment) => fragment.id);
  if (new Set(ids).size !== ids.length) return;
  return Object.freeze({
    taskId: value["taskId"],
    runId: value["runId"],
    objectiveDigest: value["objectiveDigest"],
    request: value["request"],
    repository: value["repository"],
    targets: Object.freeze(targets.map(String)),
    validationProfile: value["validationProfile"],
    changeDeclaration: value["changeDeclaration"],
    faultDeclarations: value["faultDeclarations"],
    integrations: Object.freeze([...integrations]),
    supportingFragments: Object.freeze(contextFragments),
    mode,
  });
}

function parseSkillReferences(
  input: unknown,
): readonly ExternalSkillDirectoryReference[] | undefined {
  const values = snapshotArray(input, 64);
  if (values === undefined) return;
  try {
    return createReflexionFailureRecord({
      origin: { taskId: "configuration", runId: "configuration" },
      failure: {
        kind: "configuration",
        summary: "validate configured read-only skill references",
        evidenceDigests: [],
      },
      critique: {
        cause: "configuration validation",
        correction: "use canonical skill references",
        prevention: "validate before runtime construction",
      },
      skillReferences: values as readonly ExternalSkillDirectoryReference[],
    }).skillReferences;
  } catch {
    return;
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function validDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && digestPattern.test(value);
}
