import { AgentContractPackageError } from "./contract.ts";
import type { JsonValue } from "./json-value.ts";
import { assertArray, assertRecord } from "./json-value.ts";

const CONTEXT_PROPERTY_FIELDS = [
  "name",
  "value",
  "origin",
  "createdAt",
  "trustClass",
  "integrity",
  "scope",
  "objective",
  "policyVersion",
  "retention",
  "sensitivity",
  "redaction",
  "transformations",
  "validation",
] as const;

function validateSchemaSemantics(
  path: string,
  value: JsonValue,
  label: string,
): void {
  const root = assertRecord(value, label);
  if (path.endsWith("context-envelope.schema.json")) {
    validateContextSchema(root, label);
    return;
  }
  if (path.endsWith("handoff-review.schema.json")) {
    validateHandoffSchema(root, label);
    return;
  }
  if (path.endsWith("acceptance.schema.json")) {
    validateAcceptanceSchema(root, label);
  }
}

function validateContextSchema(
  root: Record<string, JsonValue>,
  label: string,
): void {
  assertRequiredMembers(
    recordAt(root, "$defs.contextProperty", label),
    CONTEXT_PROPERTY_FIELDS,
    `${label} context property`,
  );
  assertSchemaValue(
    root,
    "$defs.contextProperty.properties.integrity.properties.algorithm.const",
    "sha-256",
    label,
  );
  assertSha256Pattern(
    root,
    "$defs.contextProperty.properties.integrity.properties.sha256",
    label,
  );
}

function validateHandoffSchema(
  root: Record<string, JsonValue>,
  label: string,
): void {
  assertSchemaValue(root, "properties.createdAt.format", "date-time", label);
  assertSchemaValue(root, "properties.expiresAt.format", "date-time", label);
  assertSchemaValue(
    root,
    "properties.authors.properties.selfReview.const",
    false,
    label,
  );
  for (const digestPath of [
    "properties.objective.properties.digest",
    "$defs.integrityReference.properties.sha256",
    "properties.acceptance.properties.digest",
    "properties.policy.properties.digest",
    "properties.policy.properties.modelDigest",
  ]) {
    assertSha256Pattern(root, digestPath, label);
  }
}

function validateAcceptanceSchema(
  root: Record<string, JsonValue>,
  label: string,
): void {
  validateEvaluationOrder(
    recordAt(root, "properties.evaluationOrder", label),
    label,
  );
  assertSchemaValue(
    root,
    "properties.authors.properties.selfReview.const",
    false,
    label,
  );
  for (const digestPath of [
    "properties.artifacts.items.properties.sha256",
    "properties.judge.properties.promptSha256",
  ]) {
    assertSha256Pattern(root, digestPath, label);
  }
}

function validateEvaluationOrder(
  schema: Record<string, JsonValue>,
  label: string,
): void {
  const prefixItems = assertArray(
    schema["prefixItems"],
    `${label} evaluation order`,
  );
  const objectiveGate = assertRecord(
    prefixItems[0],
    `${label} objective gate order`,
  );
  const judge = assertRecord(prefixItems[1], `${label} judge order`);
  if (
    prefixItems.length !== 2 ||
    objectiveGate["const"] !== "objectiveGates" ||
    judge["const"] !== "judge" ||
    schema["items"] !== false ||
    schema["minItems"] !== 2 ||
    schema["maxItems"] !== 2
  ) {
    throw new AgentContractPackageError(
      `${label} must order objective gates before the optional judge.`,
    );
  }
}

function assertRequiredMembers(
  schema: Record<string, JsonValue>,
  expected: readonly string[],
  label: string,
): void {
  const required = assertArray(schema["required"], `${label}.required`);
  const members = required.map((item) => {
    if (typeof item !== "string") {
      throw new AgentContractPackageError(
        `${label}.required must contain strings.`,
      );
    }
    return item;
  });
  if (
    members.length !== expected.length ||
    expected.some((member) => !members.includes(member))
  ) {
    throw new AgentContractPackageError(
      `${label}.required is missing property-scoped metadata.`,
    );
  }
}

function assertSchemaValue(
  root: Record<string, JsonValue>,
  path: string,
  expected: JsonValue,
  label: string,
): void {
  const segments = path.split(".");
  const property = segments.pop();
  if (property === undefined) {
    throw new AgentContractPackageError(`${label} has an invalid check path.`);
  }
  const container = recordAt(root, segments.join("."), label);
  if (container[property] !== expected) {
    throw new AgentContractPackageError(
      `${label}.${path} has an unsafe contract value.`,
    );
  }
}

function assertSha256Pattern(
  root: Record<string, JsonValue>,
  path: string,
  label: string,
): void {
  assertSchemaValue(root, `${path}.pattern`, "^[a-f0-9]{64}$", label);
}

function recordAt(
  root: Record<string, JsonValue>,
  path: string,
  label: string,
): Record<string, JsonValue> {
  let current = root;
  for (const segment of path.split(".")) {
    current = assertRecord(current[segment], `${label}.${path}`);
  }
  return current;
}

export { validateSchemaSemantics };
