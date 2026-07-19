import {
  AgentContractPackageError,
  CONTRACT_CORPUS_VERSION,
  CONTRACT_SCHEMA_VERSION,
} from "../contract.ts";
import {
  type AgentContractKind,
  ContractRejection,
  parseEvaluationOptions,
  sha256Json,
} from "../evaluation/contract.ts";
import { evaluateAgentContract } from "../evaluation/dispatch.ts";
import type { JsonValue } from "../json/value.ts";
import {
  assertArray,
  assertExactKeys,
  assertInteger,
  assertRecord,
  assertString,
} from "../json/value.ts";
import { type ExpectedCase, expectedIncidentCases } from "./cases.ts";
import { materializeMutations } from "./mutation.ts";

interface CorpusControl {
  id: string;
  contract: AgentContractKind;
  input: JsonValue;
}

interface ParsedControls {
  byId: ReadonlyMap<string, CorpusControl>;
  hashes: ReadonlyMap<string, string>;
}

export function validateIncidentCorpus(
  value: JsonValue,
  label: string,
  corpusKind: "acceptance" | "trust-boundary",
): void {
  const corpus = assertRecord(value, label);
  assertExactKeys(
    corpus,
    [
      "schemaVersion",
      "corpusVersion",
      "evaluationOptions",
      "controls",
      "cases",
    ],
    label,
  );
  if (corpus["schemaVersion"] !== CONTRACT_SCHEMA_VERSION) {
    throw new AgentContractPackageError(`${label} has a stale schemaVersion.`);
  }
  if (corpus["corpusVersion"] !== CONTRACT_CORPUS_VERSION) {
    throw new AgentContractPackageError(`${label} has a stale corpusVersion.`);
  }
  const options = parseEvaluationOptions(
    requiredValue(corpus["evaluationOptions"], `${label}.evaluationOptions`),
  );
  const controls = parseControls(corpus["controls"], options, label);
  const expectedCases = expectedIncidentCases(corpusKind);
  evaluateCases(corpus["cases"], expectedCases, controls, options, label);
}

function parseControls(
  value: JsonValue | undefined,
  options: ReturnType<typeof parseEvaluationOptions>,
  label: string,
): ParsedControls {
  const items = assertArray(value, `${label}.controls`);
  const controls = items.map((item, index) => {
    const controlLabel = `${label}.controls[${index}]`;
    const control = assertRecord(item, controlLabel);
    assertExactKeys(
      control,
      ["id", "contract", "input", "inputSha256"],
      controlLabel,
    );
    const input = requiredValue(control["input"], `${controlLabel}.input`);
    const parsed = {
      id: assertString(control["id"], `${controlLabel}.id`),
      contract: parseContract(control["contract"], `${controlLabel}.contract`),
      input,
    };
    assertInputHash(control["inputSha256"], input, controlLabel);
    evaluateAgentContract(parsed.contract, parsed.input, options);
    return parsed;
  });
  const result = new Map<string, CorpusControl>();
  const hashes = new Map<string, string>();
  for (const control of controls) {
    if (result.has(control.id)) {
      throw new AgentContractPackageError(
        `${label} has duplicate control ids.`,
      );
    }
    const hash = sha256Json(control.input);
    const previous = hashes.get(hash);
    if (previous !== undefined) {
      throw new AgentContractPackageError(
        `${label} control ${control.id} duplicates input from ${previous}.`,
      );
    }
    result.set(control.id, control);
    hashes.set(hash, control.id);
  }
  return { byId: result, hashes };
}

function evaluateCases(
  value: JsonValue | undefined,
  expectedCases: readonly ExpectedCase[],
  controls: ParsedControls,
  options: ReturnType<typeof parseEvaluationOptions>,
  label: string,
): void {
  const cases = assertArray(value, `${label}.cases`);
  if (cases.length !== expectedCases.length) {
    throw new AgentContractPackageError(
      `${label} must contain ${expectedCases.length} incident cases.`,
    );
  }
  const seenIds = new Set<string>();
  const seenInputs = new Map<string, string>();
  cases.forEach((item, index) => {
    const expected = expectedCases[index];
    if (expected === undefined) {
      throw new AgentContractPackageError(
        `${label}.cases[${index}] is unexpected.`,
      );
    }
    evaluateCase(
      item,
      index,
      expected,
      controls,
      options,
      seenIds,
      seenInputs,
      label,
    );
  });
}

function evaluateCase(
  value: JsonValue,
  index: number,
  expected: ExpectedCase,
  controls: ParsedControls,
  options: ReturnType<typeof parseEvaluationOptions>,
  seenIds: Set<string>,
  seenInputs: Map<string, string>,
  label: string,
): void {
  const caseLabel = `${label}.cases[${index}]`;
  const incident = assertRecord(value, caseLabel);
  assertExactKeys(
    incident,
    [
      "id",
      "ordinal",
      "contract",
      "control",
      "mutations",
      "inputSha256",
      "expected",
    ],
    caseLabel,
  );
  const id = assertString(incident["id"], `${caseLabel}.id`);
  if (seenIds.has(id)) {
    throw new AgentContractPackageError(`${label} has duplicate case ids.`);
  }
  seenIds.add(id);
  const ordinal = assertInteger(incident["ordinal"], `${caseLabel}.ordinal`);
  const contract = parseContract(incident["contract"], `${caseLabel}.contract`);
  if (
    id !== expected.id ||
    ordinal !== index + 1 ||
    contract !== expected.contract
  ) {
    throw new AgentContractPackageError(
      `${caseLabel} is out of canonical order.`,
    );
  }
  const controlId = assertString(incident["control"], `${caseLabel}.control`);
  const control = controls.byId.get(controlId);
  if (control === undefined || control.contract !== contract) {
    throw new AgentContractPackageError(
      `${caseLabel} references an invalid control.`,
    );
  }
  const input = materializeMutations(
    control.input,
    incident["mutations"],
    caseLabel,
  );
  assertInputHash(incident["inputSha256"], input, caseLabel);
  const inputHash = sha256Json(input);
  const controlCollision = controls.hashes.get(inputHash);
  if (controlCollision !== undefined && expected.decision === "reject") {
    throw new AgentContractPackageError(
      `${caseLabel} duplicates control input from ${controlCollision}.`,
    );
  }
  const previousId = seenInputs.get(inputHash);
  if (previousId !== undefined) {
    throw new AgentContractPackageError(
      `${caseLabel} duplicates materialized input from ${previousId}.`,
    );
  }
  seenInputs.set(inputHash, id);
  assertExpectedResult(incident["expected"], expected, caseLabel);
  assertEvaluation(input, contract, options, expected, caseLabel);
}

function assertExpectedResult(
  value: JsonValue | undefined,
  expected: ExpectedCase,
  label: string,
): void {
  const result = assertRecord(value, `${label}.expected`);
  assertExactKeys(result, ["decision", "code"], `${label}.expected`);
  if (
    result["decision"] !== expected.decision ||
    result["code"] !== expected.code
  ) {
    throw new AgentContractPackageError(
      `${label}.expected does not match its case contract.`,
    );
  }
}

function assertEvaluation(
  input: JsonValue,
  contract: AgentContractKind,
  options: ReturnType<typeof parseEvaluationOptions>,
  expected: ExpectedCase,
  label: string,
): void {
  try {
    evaluateAgentContract(contract, input, options);
  } catch (error) {
    if (error instanceof ContractRejection) {
      if (expected.decision === "reject" && error.code === expected.code) {
        return;
      }
      throw new AgentContractPackageError(
        `${label} rejected with unexpected code ${error.code}.`,
      );
    }
    throw error;
  }
  if (expected.decision !== "accept") {
    throw new AgentContractPackageError(
      `${label} unexpectedly passed evaluation.`,
    );
  }
}

function assertInputHash(
  value: JsonValue | undefined,
  input: JsonValue,
  label: string,
): void {
  if (value !== sha256Json(input)) {
    throw new AgentContractPackageError(
      `${label}.inputSha256 does not bind the materialized input.`,
    );
  }
}

function parseContract(
  value: JsonValue | undefined,
  label: string,
): AgentContractKind {
  const contract = assertString(value, label);
  if (
    contract !== "acceptance" &&
    contract !== "context-envelope" &&
    contract !== "handoff-review"
  ) {
    throw new AgentContractPackageError(`${label} is unsupported.`);
  }
  return contract;
}

function requiredValue(value: JsonValue | undefined, label: string): JsonValue {
  if (value === undefined) {
    throw new AgentContractPackageError(`${label} is required.`);
  }
  return value;
}
