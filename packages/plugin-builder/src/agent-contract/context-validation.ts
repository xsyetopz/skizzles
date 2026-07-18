import { AgentContractPackageError } from "./contract.ts";
import {
  assertUnique,
  assertVersionedMatch,
  digest,
  type EvaluationOptions,
  identityVersion,
  instant,
  nonempty,
  reject,
} from "./evaluation-contract.ts";
import type { JsonValue } from "./json-value.ts";
import {
  assertArray,
  assertExactKeys,
  assertRecord,
  assertString,
} from "./json-value.ts";

const TRUST_CLASSES = new Set(["untrusted", "validated", "trusted"]);

interface ContextValidationInput {
  transformations: JsonValue | undefined;
  validation: JsonValue | undefined;
  trustClass: JsonValue | undefined;
  propertyName: string;
  createdAt: number;
  retrievedAt: number;
  options: EvaluationOptions;
  label: string;
}

export function evaluateContextValidation(input: ContextValidationInput): void {
  const transformations = evaluateTransformations(
    input.transformations,
    input.createdAt,
    input.options,
    input.label,
  );
  evaluateValidation(
    input.validation,
    input.propertyName,
    input.trustClass,
    transformations.modelTransformed,
    transformations.finalAt,
    input.retrievedAt,
    input.options,
    input.label,
  );
}

function evaluateTransformations(
  value: JsonValue | undefined,
  createdAt: number,
  options: EvaluationOptions,
  label: string,
): { modelTransformed: boolean; finalAt: number } {
  const transformations = assertArray(value, `${label}.transformations`);
  let modelTransformed = false;
  let finalAt = createdAt;
  for (const [index, item] of transformations.entries()) {
    const itemLabel = `${label}.transformations[${index}]`;
    const transformation = assertRecord(item, itemLabel);
    assertExactKeys(transformation, ["kind", "producer", "at"], itemLabel);
    const kind = assertString(transformation["kind"], `${itemLabel}.kind`);
    if (
      !new Set(["parse", "summarize", "translate", "redact", "normalize"]).has(
        kind,
      )
    ) {
      throw new AgentContractPackageError(
        `${label} transformation kind is unsupported.`,
      );
    }
    const at = instant(transformation["at"], `${itemLabel}.at`);
    if (at < createdAt || at > options.now) {
      reject(
        "CHRONOLOGY_INVALID",
        `${label} transformation timestamp is invalid`,
      );
    }
    finalAt = Math.max(finalAt, at);
    const producer = parseProducer(
      transformation["producer"],
      `${itemLabel}.producer`,
    );
    if (producer.kind === "model") {
      modelTransformed = true;
      assertVersionedMatch(
        producer,
        options.model,
        "MODEL_MISMATCH",
        `${label} model producer`,
      );
    }
  }
  return { modelTransformed, finalAt };
}

function evaluateValidation(
  value: JsonValue | undefined,
  propertyName: string,
  trustValue: JsonValue | undefined,
  modelTransformed: boolean,
  finalTransformationAt: number,
  retrievedAt: number,
  options: EvaluationOptions,
  label: string,
): void {
  const trustClass = assertString(trustValue, `${label}.trustClass`);
  if (!TRUST_CLASSES.has(trustClass)) {
    throw new AgentContractPackageError(`${label}.trustClass is unsupported.`);
  }
  const validation = assertRecord(value, `${label}.validation`);
  assertExactKeys(
    validation,
    ["property", "status", "validator", "validatedAt", "evidence"],
    `${label}.validation`,
  );
  const status = assertString(
    validation["status"],
    `${label}.validation.status`,
  );
  if (
    !new Set([
      "unvalidated",
      "valid",
      "invalid",
      "stale",
      "expired",
      "redacted",
    ]).has(status)
  ) {
    throw new AgentContractPackageError(
      `${label}.validation.status is unsupported.`,
    );
  }
  const validationProperty = nonempty(
    validation["property"],
    `${label}.validation.property`,
  );
  const evidence = evaluateValidationEvidence(validation["evidence"], label);
  const validator = parseOptionalValidator(
    validation["validator"],
    `${label}.validation.validator`,
  );
  const validatedAt = parseOptionalValidationTime(
    validation["validatedAt"],
    `${label}.validation.validatedAt`,
  );
  const propertyMatched = validationProperty === propertyName;
  const validatorMatched =
    validator !== null &&
    validator.id === options.validator.id &&
    validator.version === options.validator.version;
  const timeMatched =
    validatedAt !== null &&
    validatedAt >= finalTransformationAt &&
    validatedAt >= retrievedAt &&
    validatedAt <= options.now;
  const deterministicallyValid =
    status === "valid" &&
    propertyMatched &&
    validatorMatched &&
    timeMatched &&
    evidence.length > 0;
  if (status === "valid" && !validatorMatched) {
    reject("VALIDATOR_MISMATCH", `${label} validator identity does not match`);
  }
  if (!propertyMatched) {
    reject("VALIDATOR_MISMATCH", `${label} validation property does not match`);
  }
  if (status === "valid" && validatedAt !== null && !timeMatched) {
    reject("CHRONOLOGY_INVALID", `${label} validation timestamp is invalid`);
  }
  if (
    status !== "valid" &&
    (validator !== null || validatedAt !== null || evidence.length > 0)
  ) {
    reject(
      "VALIDATOR_MISMATCH",
      `${label} non-valid status carries validation claims`,
    );
  }
  if (
    modelTransformed &&
    trustClass !== "untrusted" &&
    !deterministicallyValid
  ) {
    reject(
      "LLM_TRANSFORM_UNVALIDATED",
      `${label} model transformation lacks property-matched deterministic validation`,
    );
  }
  if (trustClass !== "untrusted" && !deterministicallyValid) {
    reject("VALIDATOR_MISMATCH", `${label} trusted value lacks valid evidence`);
  }
}

function evaluateValidationEvidence(
  value: JsonValue | undefined,
  label: string,
): string[] {
  const evidence = assertArray(value, `${label}.validation.evidence`);
  const refs = evidence.map((item, index) => {
    const itemLabel = `${label}.validation.evidence[${index}]`;
    const entry = assertRecord(item, itemLabel);
    assertExactKeys(entry, ["kind", "ref", "sha256"], itemLabel);
    const kind = assertString(entry["kind"], `${itemLabel}.kind`);
    if (!new Set(["parser", "hash", "runtime"]).has(kind)) {
      throw new AgentContractPackageError(
        `${label} validation evidence kind is unsupported.`,
      );
    }
    digest(entry["sha256"], `${itemLabel}.sha256`);
    return nonempty(entry["ref"], `${itemLabel}.ref`);
  });
  assertUnique(refs, `${label} validation evidence refs`);
  return refs;
}

function parseOptionalValidator(
  value: JsonValue | undefined,
  label: string,
): { id: string; version: string } | null {
  return value === null ? null : identityVersion(value, label);
}

function parseOptionalValidationTime(
  value: JsonValue | undefined,
  label: string,
): number | null {
  return value === null ? null : instant(value, label);
}

function parseProducer(
  value: JsonValue | undefined,
  label: string,
): { kind: string; id: string; version: string; digest: string } {
  const producer = assertRecord(value, label);
  assertExactKeys(producer, ["kind", "id", "version", "digest"], label);
  const kind = assertString(producer["kind"], `${label}.kind`);
  if (kind !== "deterministic" && kind !== "model") {
    throw new AgentContractPackageError(`${label}.kind is unsupported.`);
  }
  return {
    kind,
    id: nonempty(producer["id"], `${label}.id`),
    version: nonempty(producer["version"], `${label}.version`),
    digest: digest(producer["digest"], `${label}.digest`),
  };
}
