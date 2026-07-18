import { evaluateContextValidation } from "./context-validation.ts";
import {
  AgentContractPackageError,
  CONTRACT_SCHEMA_VERSION,
} from "./contract.ts";
import {
  asInstanceEvaluation,
  assertVersionedMatch,
  digest,
  type EvaluationOptions,
  instant,
  nonempty,
  objectiveIdentity,
  reject,
  sha256Json,
  versionedDigest,
} from "./evaluation-contract.ts";
import type { JsonValue } from "./json-value.ts";
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertRecord,
  assertString,
} from "./json-value.ts";

const CONTEXT_PROPERTY_KEYS = [
  "name",
  "value",
  "origin",
  "createdAt",
  "retrievedAt",
  "trustClass",
  "integrity",
  "scope",
  "objective",
  "policy",
  "retention",
  "sensitivity",
  "redaction",
  "transformations",
  "validation",
] as const;

const SENSITIVITY_CLASSES = new Set([
  "public",
  "internal",
  "confidential",
  "secret",
]);

export function evaluateContextEnvelope(
  value: JsonValue,
  options: EvaluationOptions,
): void {
  asInstanceEvaluation(() => {
    const envelope = assertRecord(value, "context envelope");
    assertExactKeys(
      envelope,
      ["schemaVersion", "contextId", "properties"],
      "context envelope",
    );
    if (envelope["schemaVersion"] !== CONTRACT_SCHEMA_VERSION) {
      reject("SCHEMA_VERSION_MISMATCH", "context schema version is stale");
    }
    const contextId = nonempty(envelope["contextId"], "context id");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(contextId)) {
      throw new AgentContractPackageError("context id has an invalid format.");
    }
    const properties = assertArray(
      envelope["properties"],
      "context properties",
    );
    if (properties.length === 0) {
      throw new AgentContractPackageError(
        "context properties must not be empty.",
      );
    }
    const names = properties.map((property, index) =>
      evaluateContextProperty(property, index, options),
    );
    if (new Set(names).size !== names.length) {
      reject(
        "CONTEXT_PROPERTY_DUPLICATE",
        "context property names must be unique",
      );
    }
  });
}

function evaluateContextProperty(
  value: JsonValue,
  index: number,
  options: EvaluationOptions,
): string {
  const label = `context property ${index}`;
  const property = assertRecord(value, label);
  assertExactKeys(property, CONTEXT_PROPERTY_KEYS, label);
  const name = nonempty(property["name"], `${label}.name`);
  if (!/^[a-z][a-zA-Z0-9._-]{0,63}$/u.test(name)) {
    throw new AgentContractPackageError(`${label}.name has an invalid format.`);
  }
  const propertyValue = requiredValue(property["value"], `${label}.value`);
  evaluateOrigin(property["origin"], label);
  const createdAt = instant(property["createdAt"], `${label}.createdAt`);
  const retrievedAt = instant(property["retrievedAt"], `${label}.retrievedAt`);
  if (createdAt > retrievedAt || retrievedAt > options.now) {
    reject("CHRONOLOGY_INVALID", `${label} timestamps are out of order`);
  }
  evaluateIntegrity(property["integrity"], propertyValue, label);
  nonempty(property["scope"], `${label}.scope`);
  evaluateObjective(property["objective"], options, label);
  assertVersionedMatch(
    versionedDigest(property["policy"], `${label}.policy`),
    options.policy,
    "POLICY_MISMATCH",
    `${label} policy`,
  );
  evaluateRetention(property["retention"], createdAt, options.now, label);
  evaluateRedaction(property["sensitivity"], property["redaction"], label);
  evaluateContextValidation({
    transformations: property["transformations"],
    validation: property["validation"],
    trustClass: property["trustClass"],
    propertyName: name,
    createdAt,
    retrievedAt,
    options,
    label,
  });
  return name;
}

function evaluateOrigin(value: JsonValue | undefined, label: string): void {
  const origin = assertRecord(value, `${label}.origin`);
  assertExactKeys(origin, ["kind", "ref"], `${label}.origin`);
  const kind = assertString(origin["kind"], `${label}.origin.kind`);
  if (
    !new Set([
      "user",
      "repository",
      "tool",
      "agent",
      "generated",
      "external",
    ]).has(kind)
  ) {
    throw new AgentContractPackageError(`${label}.origin.kind is unsupported.`);
  }
  nonempty(origin["ref"], `${label}.origin.ref`);
}

function evaluateIntegrity(
  value: JsonValue | undefined,
  propertyValue: JsonValue,
  label: string,
): void {
  const integrity = assertRecord(value, `${label}.integrity`);
  assertExactKeys(
    integrity,
    ["algorithm", "canonicalization", "coverage", "sha256"],
    `${label}.integrity`,
  );
  if (
    integrity["algorithm"] !== "sha-256" ||
    integrity["canonicalization"] !== "canonical-json-v1" ||
    integrity["coverage"] !== "property-value"
  ) {
    reject("INTEGRITY_MISMATCH", `${label} integrity metadata is incomplete`);
  }
  const actualDigest = digest(integrity["sha256"], `${label}.integrity.sha256`);
  if (actualDigest !== sha256Json(propertyValue)) {
    reject("INTEGRITY_MISMATCH", `${label} value digest does not match`);
  }
}

function evaluateObjective(
  value: JsonValue | undefined,
  options: EvaluationOptions,
  label: string,
): void {
  const actual = objectiveIdentity(value, `${label}.objective`);
  if (
    actual.id !== options.objective.id ||
    actual.version !== options.objective.version ||
    actual.digest !== options.objective.digest
  ) {
    reject("OBJECTIVE_MISMATCH", `${label} objective does not match`);
  }
}

function evaluateRetention(
  value: JsonValue | undefined,
  createdAt: number,
  now: number,
  label: string,
): void {
  const retention = assertRecord(value, `${label}.retention`);
  assertExactKeys(retention, ["class", "expiresAt"], `${label}.retention`);
  const retentionClass = assertString(
    retention["class"],
    `${label}.retention.class`,
  );
  if (!new Set(["ephemeral", "session", "persistent"]).has(retentionClass)) {
    throw new AgentContractPackageError(
      `${label}.retention.class is unsupported.`,
    );
  }
  const expiresAt = instant(
    retention["expiresAt"],
    `${label}.retention.expiresAt`,
  );
  if (expiresAt < createdAt) {
    reject("CHRONOLOGY_INVALID", `${label} expires before creation`);
  }
  if (expiresAt <= now) {
    reject("CONTEXT_EXPIRED", `${label} retention has expired`);
  }
}

function evaluateRedaction(
  sensitivityValue: JsonValue | undefined,
  redactionValue: JsonValue | undefined,
  label: string,
): void {
  const sensitivity = assertString(sensitivityValue, `${label}.sensitivity`);
  if (!SENSITIVITY_CLASSES.has(sensitivity)) {
    throw new AgentContractPackageError(`${label}.sensitivity is unsupported.`);
  }
  const redaction = assertRecord(redactionValue, `${label}.redaction`);
  assertExactKeys(
    redaction,
    ["required", "applied", "method"],
    `${label}.redaction`,
  );
  const required = assertBoolean(
    redaction["required"],
    `${label}.redaction.required`,
  );
  const applied = assertBoolean(
    redaction["applied"],
    `${label}.redaction.applied`,
  );
  const method = assertString(redaction["method"], `${label}.redaction.method`);
  if (
    (sensitivity === "secret" || required) &&
    (!applied || method.length === 0)
  ) {
    reject(
      "SECRET_REDACTION_REQUIRED",
      `${label} secret context is not redacted`,
    );
  }
}

function requiredValue(value: JsonValue | undefined, label: string): JsonValue {
  if (value === undefined) {
    throw new AgentContractPackageError(`${label} is required.`);
  }
  return value;
}
