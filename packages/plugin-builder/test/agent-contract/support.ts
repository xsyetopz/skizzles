import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentContractKind,
  ContractRejection,
  type EvaluationOptions,
  parseEvaluationOptions,
  type RejectionCode,
  sha256Json,
} from "../../src/agent-contract/evaluation/contract.ts";
import { evaluateAgentContract } from "../../src/agent-contract/evaluation/dispatch.ts";
import type { JsonValue } from "../../src/agent-contract/json/value.ts";
import {
  assertArray,
  assertRecord,
  assertString,
  canonicalJson,
  parseJsonAsset,
} from "../../src/agent-contract/json/value.ts";

const ZERO_DIGEST = "0".repeat(64);

export interface LoadedControl {
  contract: AgentContractKind;
  input: JsonValue;
  options: EvaluationOptions;
}

export async function loadControl(
  root: string,
  corpusPath: string,
  controlId: string,
): Promise<LoadedControl> {
  const corpus = assertRecord(
    parseJsonAsset(await readFile(join(root, corpusPath)), "test corpus"),
    "test corpus",
  );
  const options = parseEvaluationOptions(
    requiredValue(corpus["evaluationOptions"]),
  );
  const controls = assertArray(corpus["controls"], "test controls");
  for (const item of controls) {
    const control = assertRecord(item, "test control");
    if (control["id"] === controlId) {
      return {
        contract: contractKind(control["contract"]),
        input: cloneJson(requiredValue(control["input"])),
        options,
      };
    }
  }
  throw new Error(`Missing test control ${controlId}.`);
}

export function evaluateControl(control: LoadedControl): void {
  evaluateAgentContract(control.contract, control.input, control.options);
}

export function rejectionCode(control: LoadedControl): RejectionCode {
  try {
    evaluateControl(control);
  } catch (error) {
    if (error instanceof ContractRejection) {
      return error.code;
    }
    throw error;
  }
  throw new Error("Expected contract evaluation to reject.");
}

export function propertyAt(input: JsonValue): Record<string, JsonValue> {
  return recordAt(requiredValue(arrayAt(input, "properties")[0]), "");
}

export function firstGate(input: JsonValue): Record<string, JsonValue> {
  return recordAt(requiredValue(arrayAt(input, "objectiveGates")[0]), "");
}

export function recordAt(
  value: JsonValue,
  path: string,
): Record<string, JsonValue> {
  let current = assertRecord(value, "test record");
  if (path.length === 0) {
    return current;
  }
  for (const segment of path.split(".")) {
    current = assertRecord(current[segment], `test record ${path}`);
  }
  return current;
}

export function arrayAt(value: JsonValue, property: string): JsonValue[] {
  return assertArray(recordAt(value, "")[property], `test array ${property}`);
}

export function cloneJson(value: JsonValue): JsonValue {
  return parseJsonAsset(Buffer.from(canonicalJson(value)), "test clone");
}

export function requiredValue(value: JsonValue | undefined): JsonValue {
  if (value === undefined) {
    throw new Error("Missing test value.");
  }
  return value;
}

export function acceptanceMutation(
  name: string,
  code: RejectionCode,
  mutate: (input: JsonValue) => void,
): { name: string; code: RejectionCode; mutate: (input: JsonValue) => void } {
  return { name, code, mutate };
}

export function trustAcceptanceRecord(control: LoadedControl): void {
  const identity = recordAt(control.input, "acceptance");
  identity["digest"] = ZERO_DIGEST;
  const trustedDigest = sha256Json(control.input);
  identity["digest"] = trustedDigest;
  control.options = {
    ...control.options,
    acceptance: {
      ...control.options.acceptance,
      digest: trustedDigest,
    },
  };
}

function contractKind(value: JsonValue | undefined): AgentContractKind {
  const kind = assertString(value, "test contract kind");
  if (
    kind !== "acceptance" &&
    kind !== "context-envelope" &&
    kind !== "handoff-review"
  ) {
    throw new Error("Invalid test contract kind.");
  }
  return kind;
}
