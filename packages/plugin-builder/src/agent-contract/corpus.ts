import { createHash } from "node:crypto";
import {
  AgentContractPackageError,
  CONTRACT_CORPUS_VERSION,
  CONTRACT_SCHEMA_VERSION,
} from "./contract.ts";
import type { JsonValue } from "./json-value.ts";
import {
  assertArray,
  assertExactKeys,
  assertInteger,
  assertRecord,
  assertString,
  canonicalJson,
} from "./json-value.ts";

type ExpectedCase = readonly [id: string, category: string, scenario: string];

export function validateIncidentCorpus(
  value: JsonValue,
  label: string,
  expectedCases: readonly ExpectedCase[],
): void {
  const corpus = assertRecord(value, label);
  assertExactKeys(corpus, ["schemaVersion", "corpusVersion", "cases"], label);
  if (corpus["schemaVersion"] !== CONTRACT_SCHEMA_VERSION) {
    throw new AgentContractPackageError(
      `${label} has an unexpected or stale schemaVersion.`,
    );
  }
  if (corpus["corpusVersion"] !== CONTRACT_CORPUS_VERSION) {
    throw new AgentContractPackageError(
      `${label} has an unexpected or stale corpusVersion.`,
    );
  }

  const cases = assertArray(corpus["cases"], `${label}.cases`);
  if (cases.length !== expectedCases.length) {
    throw new AgentContractPackageError(
      `${label}.cases must contain ${expectedCases.length} incident regressions.`,
    );
  }

  const seenIds = new Set<string>();
  cases.forEach((rawCase, index) => {
    const expected = expectedCases[index];
    if (expected === undefined) {
      throw new AgentContractPackageError(
        `${label}.cases[${index}] is unexpected.`,
      );
    }
    validateIncidentCase(rawCase, index, label, expected, seenIds);
  });
}

function validateIncidentCase(
  rawCase: JsonValue,
  index: number,
  label: string,
  expected: ExpectedCase,
  seenIds: Set<string>,
): void {
  const caseLabel = `${label}.cases[${index}]`;
  const incident = assertRecord(rawCase, caseLabel);
  assertExactKeys(
    incident,
    ["id", "ordinal", "category", "input", "inputSha256", "expected"],
    caseLabel,
  );
  validateCaseIdentity(incident, index, label, caseLabel, expected, seenIds);
  const input = validateCaseContent(incident, caseLabel, expected[2]);
  const actualHash = createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex");
  if (incident["inputSha256"] !== actualHash) {
    throw new AgentContractPackageError(
      `${caseLabel}.inputSha256 does not bind the canonical input.`,
    );
  }
}

function validateCaseIdentity(
  incident: Record<string, JsonValue>,
  index: number,
  corpusLabel: string,
  caseLabel: string,
  expected: ExpectedCase,
  seenIds: Set<string>,
): void {
  const id = assertString(incident["id"], `${caseLabel}.id`);
  if (seenIds.has(id)) {
    throw new AgentContractPackageError(
      `${corpusLabel} contains duplicate case ${id}.`,
    );
  }
  seenIds.add(id);
  if (id !== expected[0]) {
    throw new AgentContractPackageError(
      `${caseLabel}.id is out of canonical order.`,
    );
  }
  if (
    assertInteger(incident["ordinal"], `${caseLabel}.ordinal`) !==
    index + 1
  ) {
    throw new AgentContractPackageError(
      `${caseLabel}.ordinal must equal ${index + 1}.`,
    );
  }
  if (
    assertString(incident["category"], `${caseLabel}.category`) !== expected[1]
  ) {
    throw new AgentContractPackageError(
      `${caseLabel}.category does not match the canonical regression.`,
    );
  }
}

function validateCaseContent(
  incident: Record<string, JsonValue>,
  caseLabel: string,
  expectedScenario: string,
): Record<string, JsonValue> {
  const input = assertRecord(incident["input"], `${caseLabel}.input`);
  assertExactKeys(input, ["scenario"], `${caseLabel}.input`);
  if (
    assertString(input["scenario"], `${caseLabel}.input.scenario`) !==
    expectedScenario
  ) {
    throw new AgentContractPackageError(
      `${caseLabel}.input does not describe the canonical regression.`,
    );
  }
  const expectedResult = assertRecord(
    incident["expected"],
    `${caseLabel}.expected`,
  );
  assertExactKeys(expectedResult, ["decision"], `${caseLabel}.expected`);
  if (expectedResult["decision"] !== "reject") {
    throw new AgentContractPackageError(
      `${caseLabel}.expected.decision must be reject.`,
    );
  }
  return input;
}
