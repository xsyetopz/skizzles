// biome-ignore-all lint: routing contracts use explicit exact-key validation and public constructors.

import { type Digest, digestValue } from "../digest.ts";
import { snapshotRecord } from "../engineering/session/snapshot.ts";

const assignments = new WeakSet<object>();
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;

export type RoutingAssignmentMethod =
  | "prior"
  | "randomized"
  | "exploration"
  | "exploitation"
  | "manual";

export type RoutingTopology = "single-agent" | "multi-agent";

export interface RoutingWorkflowShape {
  readonly topology: RoutingTopology;
  readonly decomposition: "sequential" | "parallel" | "hybrid";
  readonly agentCount: number;
  readonly maximumParallelism: number;
  readonly contextStrategy: string;
}

export interface RoutingAssignment {
  readonly schema: "skizzles.orchestrator/routing-assignment/v1";
  readonly experimentId: string;
  readonly policyRevision: string;
  readonly safetyFloor: string;
  readonly eligibilityDigest: Digest;
  readonly candidateId: string;
  readonly candidateSet: readonly string[];
  readonly assignmentMethod: RoutingAssignmentMethod;
  readonly propensity: number;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly workflow: RoutingWorkflowShape;
  readonly assignmentDigest: Digest;
}

export function createRoutingAssignment(
  input: Omit<RoutingAssignment, "assignmentDigest" | "schema">,
): RoutingAssignment {
  const body = Object.freeze({
    schema: "skizzles.orchestrator/routing-assignment/v1" as const,
    experimentId: input.experimentId,
    policyRevision: input.policyRevision,
    safetyFloor: input.safetyFloor,
    eligibilityDigest: input.eligibilityDigest,
    candidateId: input.candidateId,
    candidateSet: Object.freeze([...input.candidateSet]),
    assignmentMethod: input.assignmentMethod,
    propensity: input.propensity,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    workflow: Object.freeze({ ...input.workflow }),
  });
  const assignment: RoutingAssignment = Object.freeze({
    ...body,
    assignmentDigest: digestValue(body),
  });
  if (parseRoutingAssignment(assignment) === undefined) {
    throw new TypeError("invalid routing assignment");
  }
  assignments.add(assignment);
  return assignment;
}

export function isRoutingAssignment(
  value: unknown,
): value is RoutingAssignment {
  return (
    typeof value === "object" &&
    value !== null &&
    assignments.has(value) &&
    Object.isFrozen(value)
  );
}

export function parseRoutingAssignment(
  input: unknown,
): RoutingAssignment | null | undefined {
  if (input === undefined || input === null) {
    return null;
  }
  const value = snapshotRecord(input, [
    "schema",
    "experimentId",
    "policyRevision",
    "safetyFloor",
    "eligibilityDigest",
    "candidateId",
    "candidateSet",
    "assignmentMethod",
    "propensity",
    "model",
    "reasoningEffort",
    "workflow",
    "assignmentDigest",
  ]);
  if (!validAssignmentShape(value)) {
    return;
  }
  const candidateSet = parseIdentifiers(value.candidateSet);
  const workflow = parseWorkflow(value.workflow);
  if (
    candidateSet === undefined ||
    !candidateSet.includes(value.candidateId) ||
    workflow === undefined
  ) {
    return;
  }
  const assignment = Object.freeze({
    schema: value.schema,
    experimentId: value.experimentId,
    policyRevision: value.policyRevision,
    safetyFloor: value.safetyFloor,
    eligibilityDigest: value.eligibilityDigest,
    candidateId: value.candidateId,
    candidateSet,
    assignmentMethod: value.assignmentMethod,
    propensity: value.propensity,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    workflow,
    assignmentDigest: value.assignmentDigest,
  });
  if (digestValue(assignmentBody(assignment)) !== assignment.assignmentDigest) {
    return;
  }
  assignments.add(assignment);
  return assignment;
}

function validAssignmentShape(
  value: ReturnType<typeof snapshotRecord>,
): value is Readonly<{
  schema: "skizzles.orchestrator/routing-assignment/v1";
  experimentId: string;
  policyRevision: string;
  safetyFloor: string;
  eligibilityDigest: Digest;
  candidateId: string;
  candidateSet: unknown;
  assignmentMethod: RoutingAssignmentMethod;
  propensity: number;
  model: string;
  reasoningEffort: string;
  workflow: unknown;
  assignmentDigest: Digest;
}> {
  return (
    value !== undefined &&
    value["schema"] === "skizzles.orchestrator/routing-assignment/v1" &&
    validIdentifier(value["experimentId"]) &&
    validIdentifier(value["policyRevision"]) &&
    validIdentifier(value["safetyFloor"]) &&
    validDigest(value["eligibilityDigest"]) &&
    validIdentifier(value["candidateId"]) &&
    isAssignmentMethod(value["assignmentMethod"]) &&
    typeof value["propensity"] === "number" &&
    Number.isFinite(value["propensity"]) &&
    value["propensity"] > 0 &&
    value["propensity"] <= 1 &&
    validModel(value["model"]) &&
    validModel(value["reasoningEffort"]) &&
    validDigest(value["assignmentDigest"])
  );
}

function assignmentBody(
  assignment: Omit<RoutingAssignment, "assignmentDigest">,
): Omit<RoutingAssignment, "assignmentDigest"> {
  return Object.freeze({
    schema: assignment.schema,
    experimentId: assignment.experimentId,
    policyRevision: assignment.policyRevision,
    safetyFloor: assignment.safetyFloor,
    eligibilityDigest: assignment.eligibilityDigest,
    candidateId: assignment.candidateId,
    candidateSet: assignment.candidateSet,
    assignmentMethod: assignment.assignmentMethod,
    propensity: assignment.propensity,
    model: assignment.model,
    reasoningEffort: assignment.reasoningEffort,
    workflow: assignment.workflow,
  });
}

function parseIdentifiers(input: unknown): readonly string[] | undefined {
  if (!Array.isArray(input) || input.length === 0 || input.length > 128) {
    return;
  }
  const values = input.map((item) => item);
  if (
    !values.every(validIdentifier) ||
    new Set(values).size !== values.length
  ) {
    return;
  }
  return Object.freeze([...values]);
}

function parseWorkflow(input: unknown): RoutingWorkflowShape | undefined {
  const value = snapshotRecord(input, [
    "topology",
    "decomposition",
    "agentCount",
    "maximumParallelism",
    "contextStrategy",
  ]);
  if (
    value === undefined ||
    (value["topology"] !== "single-agent" &&
      value["topology"] !== "multi-agent") ||
    (value["decomposition"] !== "sequential" &&
      value["decomposition"] !== "parallel" &&
      value["decomposition"] !== "hybrid") ||
    !boundedInteger(value["agentCount"], 1, 256) ||
    !boundedInteger(value["maximumParallelism"], 1, 256) ||
    !validIdentifier(value["contextStrategy"])
  ) {
    return;
  }
  return Object.freeze({
    topology: value["topology"],
    decomposition: value["decomposition"],
    agentCount: value["agentCount"],
    maximumParallelism: value["maximumParallelism"],
    contextStrategy: value["contextStrategy"],
  });
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

function isAssignmentMethod(value: unknown): value is RoutingAssignmentMethod {
  return (
    value === "prior" ||
    value === "randomized" ||
    value === "exploration" ||
    value === "exploitation" ||
    value === "manual"
  );
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function validModel(value: unknown): value is string {
  return typeof value === "string" && modelPattern.test(value);
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}
