import {
  digest,
  type EvaluationOptions,
  nonempty,
  reject,
  sha256Json,
} from "../evaluation/contract.ts";
import type { JsonValue } from "../json/value.ts";
import { assertExactKeys, assertRecord } from "../json/value.ts";

export function evaluateAcceptanceIdentity(
  acceptance: Record<string, JsonValue>,
  options: EvaluationOptions,
): void {
  const objective = assertRecord(
    acceptance["objective"],
    "acceptance.objective",
  );
  assertExactKeys(
    objective,
    ["id", "version", "digest"],
    "acceptance.objective",
  );
  if (
    nonempty(objective["id"], "acceptance.objective.id") !==
      options.objective.id ||
    nonempty(objective["version"], "acceptance.objective.version") !==
      options.objective.version ||
    digest(objective["digest"], "acceptance.objective.digest") !==
      options.objective.digest
  ) {
    reject(
      "OBJECTIVE_MISMATCH",
      "acceptance objective identity does not match",
    );
  }
  const identity = assertRecord(
    acceptance["acceptance"],
    "acceptance.acceptance",
  );
  assertExactKeys(identity, ["version", "digest"], "acceptance.acceptance");
  const submittedDigest = digest(
    identity["digest"],
    "acceptance.acceptance.digest",
  );
  const normalized = {
    ...acceptance,
    acceptance: {
      version: nonempty(identity["version"], "acceptance.acceptance.version"),
      digest: "0".repeat(64),
    },
  } satisfies Record<string, JsonValue>;
  if (
    normalized.acceptance.version !== options.acceptance.version ||
    submittedDigest !== options.acceptance.digest ||
    sha256Json(normalized) !== options.acceptance.digest
  ) {
    reject(
      "ACCEPTANCE_MISMATCH",
      "acceptance record does not match its trusted canonical digest",
    );
  }
}
