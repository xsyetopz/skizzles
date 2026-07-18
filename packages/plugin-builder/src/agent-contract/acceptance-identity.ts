import {
  assertVersionedMatch,
  digest,
  type EvaluationOptions,
  nonempty,
  reject,
} from "./evaluation-contract.ts";
import type { JsonValue } from "./json-value.ts";
import { assertExactKeys, assertRecord } from "./json-value.ts";

export function evaluateAcceptanceIdentity(
  objectiveValue: JsonValue | undefined,
  acceptanceValue: JsonValue | undefined,
  options: EvaluationOptions,
): void {
  const objective = assertRecord(objectiveValue, "acceptance.objective");
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
  const identity = assertRecord(acceptanceValue, "acceptance.acceptance");
  assertExactKeys(identity, ["version", "digest"], "acceptance.acceptance");
  assertVersionedMatch(
    {
      version: nonempty(identity["version"], "acceptance.acceptance.version"),
      digest: digest(identity["digest"], "acceptance.acceptance.digest"),
    },
    options.acceptance,
    "ACCEPTANCE_MISMATCH",
    "acceptance identity",
  );
}
