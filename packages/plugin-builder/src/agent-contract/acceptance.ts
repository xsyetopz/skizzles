import {
  type AcceptanceEvidence,
  type CausalEvidenceKind,
  parseAcceptanceEvidence,
  requireCausalGateEvidence,
} from "./acceptance-evidence.ts";
import { evaluateAcceptanceIdentity } from "./acceptance-identity.ts";
import {
  AgentContractPackageError,
  CONTRACT_SCHEMA_VERSION,
} from "./contract.ts";
import {
  asInstanceEvaluation,
  assertUnique,
  assertVersionedMatch,
  digest,
  type EvaluationOptions,
  identityVersion,
  nonempty,
  type RejectionCode,
  reject,
} from "./evaluation-contract.ts";
import type { JsonValue } from "./json-value.ts";
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertInteger,
  assertRecord,
  assertString,
} from "./json-value.ts";

interface ObjectiveGate {
  order: number;
  requirementId: string;
  result: "fail" | "pass";
  evidenceRefs: string[];
  proofKind: CausalEvidenceKind;
}

const FINDING_CODES: Readonly<Record<string, RejectionCode>> = {
  "verifier-mutation": "VERIFIER_MUTATION",
  "test-mutation": "TEST_MUTATION",
  "solution-leakage": "SOLUTION_LEAKAGE",
  "grader-injection": "GRADER_INJECTION",
  "hard-coded-answer": "HARD_CODED_ANSWER",
  "deceptive-completion": "DECEPTIVE_COMPLETION",
};

export function evaluateAcceptance(
  value: JsonValue,
  options: EvaluationOptions,
): void {
  asInstanceEvaluation(() => {
    const acceptance = assertRecord(value, "acceptance");
    assertExactKeys(
      acceptance,
      [
        "schemaVersion",
        "objective",
        "acceptance",
        "requirements",
        "objectiveGates",
        "evaluationOrder",
        "artifacts",
        "evidence",
        "effects",
        "findings",
        "execution",
        "policy",
        "validator",
        "judge",
        "authors",
      ],
      "acceptance",
    );
    if (acceptance["schemaVersion"] !== CONTRACT_SCHEMA_VERSION) {
      reject("SCHEMA_VERSION_MISMATCH", "acceptance schema version is stale");
    }
    evaluateAcceptanceIdentity(
      acceptance["objective"],
      acceptance["acceptance"],
      options,
    );
    const requirementIds = parseRequirements(acceptance["requirements"]);
    const gates = parseObjectiveGates(
      acceptance["objectiveGates"],
      requirementIds,
    );
    evaluateOrder(acceptance["evaluationOrder"]);
    const { evidence } = parseAcceptanceEvidence(
      acceptance["artifacts"],
      acceptance["evidence"],
      acceptance["effects"],
      options,
    );
    evaluateFindings(acceptance["findings"]);
    evaluateExecution(acceptance["execution"], options);
    evaluatePolicy(acceptance["policy"], options);
    evaluateValidator(acceptance["validator"], options);
    evaluateObjectiveGates(gates, evidence);
    evaluateJudge(acceptance["judge"], options);
    evaluateAuthors(acceptance["authors"]);
  });
}

function parseRequirements(value: JsonValue | undefined): Set<string> {
  const items = assertArray(value, "acceptance.requirements");
  if (items.length === 0) {
    throw new AgentContractPackageError(
      "acceptance.requirements must not be empty.",
    );
  }
  const ids = items.map((item, index) => {
    const label = `acceptance.requirements[${index}]`;
    const requirement = assertRecord(item, label);
    assertExactKeys(requirement, ["id", "obligation"], label);
    const id = nonempty(requirement["id"], `${label}.id`);
    if (!/^[A-Z][A-Z0-9-]{1,31}$/u.test(id)) {
      throw new AgentContractPackageError(`${label}.id has an invalid format.`);
    }
    nonempty(requirement["obligation"], `${label}.obligation`);
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    reject(
      "REQUIREMENT_DUPLICATE",
      "acceptance requirement ids must be unique",
    );
  }
  return new Set(ids);
}

function parseObjectiveGates(
  value: JsonValue | undefined,
  requirementIds: ReadonlySet<string>,
): ObjectiveGate[] {
  const items = assertArray(value, "acceptance.objectiveGates");
  if (items.length === 0) {
    throw new AgentContractPackageError(
      "acceptance.objectiveGates must not be empty.",
    );
  }
  const gates = items.map((item, index) => {
    const label = `acceptance.objectiveGates[${index}]`;
    const gate = assertRecord(item, label);
    assertExactKeys(
      gate,
      [
        "order",
        "requirementId",
        "check",
        "proofKind",
        "result",
        "evidenceRefs",
      ],
      label,
    );
    const requirementId = nonempty(
      gate["requirementId"],
      `${label}.requirementId`,
    );
    if (!requirementIds.has(requirementId)) {
      reject(
        "GATE_REQUIREMENT_UNKNOWN",
        `${label} references an unknown requirement`,
      );
    }
    nonempty(gate["check"], `${label}.check`);
    const result = parseGateResult(gate["result"], `${label}.result`);
    const proofKind = parseProofKind(gate["proofKind"], `${label}.proofKind`);
    const evidenceRefs = assertArray(
      gate["evidenceRefs"],
      `${label}.evidenceRefs`,
    ).map((ref, refIndex) =>
      nonempty(ref, `${label}.evidenceRefs[${refIndex}]`),
    );
    if (evidenceRefs.length === 0) {
      reject("GATE_EVIDENCE_MISSING", `${label} has no evidence`);
    }
    assertUnique(evidenceRefs, `${label} evidence refs`);
    return {
      order: assertInteger(gate["order"], `${label}.order`),
      requirementId,
      result,
      evidenceRefs,
      proofKind,
    };
  });
  validateGateTopology(gates, requirementIds);
  return gates;
}

function parseProofKind(
  value: JsonValue | undefined,
  label: string,
): CausalEvidenceKind {
  const kind = assertString(value, label);
  if (kind !== "runtime-effect" && kind !== "test-result") {
    throw new AgentContractPackageError(`${label} is unsupported.`);
  }
  return kind;
}

function parseGateResult(
  value: JsonValue | undefined,
  label: string,
): ObjectiveGate["result"] {
  const result = assertString(value, label);
  if (result !== "pass" && result !== "fail") {
    throw new AgentContractPackageError(`${label} is unsupported.`);
  }
  return result;
}

function validateGateTopology(
  gates: readonly ObjectiveGate[],
  requirementIds: ReadonlySet<string>,
): void {
  const orders = gates.map((gate) => gate.order);
  const gateRequirements = gates.map((gate) => gate.requirementId);
  if (
    new Set(orders).size !== orders.length ||
    orders.some((order, index) => order !== index + 1)
  ) {
    reject(
      "GATE_ORDER_INVALID",
      "objective gate order must be unique and contiguous",
    );
  }
  if (
    new Set(gateRequirements).size !== gateRequirements.length ||
    gateRequirements.length !== requirementIds.size
  ) {
    reject(
      "GATE_ORDER_INVALID",
      "each requirement must have exactly one objective gate",
    );
  }
}

function evaluateOrder(value: JsonValue | undefined): void {
  const order = assertArray(value, "acceptance.evaluationOrder");
  if (
    order.length !== 2 ||
    order[0] !== "objectiveGates" ||
    order[1] !== "judge"
  ) {
    reject("JUDGE_ORDER_INVALID", "objective gates must run before the judge");
  }
}

function evaluateFindings(value: JsonValue | undefined): void {
  const findings = assertArray(value, "acceptance.findings");
  for (const [index, item] of findings.entries()) {
    const label = `acceptance.findings[${index}]`;
    const finding = assertRecord(item, label);
    assertExactKeys(finding, ["kind", "ref"], label);
    const kind = assertString(finding["kind"], `${label}.kind`);
    nonempty(finding["ref"], `${label}.ref`);
    const code = FINDING_CODES[kind];
    if (code === undefined) {
      throw new AgentContractPackageError(`${label}.kind is unsupported.`);
    }
    reject(code, `acceptance integrity finding ${kind}`);
  }
}

function evaluateExecution(
  value: JsonValue | undefined,
  options: EvaluationOptions,
): void {
  const execution = assertRecord(value, "acceptance.execution");
  assertExactKeys(execution, ["retries", "seed"], "acceptance.execution");
  const retries = assertInteger(
    execution["retries"],
    "acceptance.execution.retries",
  );
  const seed = assertInteger(execution["seed"], "acceptance.execution.seed");
  if (retries < 0 || retries > options.maxRetries) {
    reject(
      "RETRY_LIMIT_EXCEEDED",
      "acceptance retry count exceeds the fixed limit",
    );
  }
  if (seed < 0) {
    throw new AgentContractPackageError(
      "acceptance.execution.seed must be non-negative.",
    );
  }
}

function evaluatePolicy(
  value: JsonValue | undefined,
  options: EvaluationOptions,
): void {
  const policy = assertRecord(value, "acceptance.policy");
  assertExactKeys(
    policy,
    ["version", "digest", "modelVersion", "modelDigest"],
    "acceptance.policy",
  );
  assertVersionedMatch(
    {
      version: nonempty(policy["version"], "acceptance.policy.version"),
      digest: digest(policy["digest"], "acceptance.policy.digest"),
    },
    options.policy,
    "POLICY_MISMATCH",
    "acceptance policy",
  );
  assertVersionedMatch(
    {
      version: nonempty(
        policy["modelVersion"],
        "acceptance.policy.modelVersion",
      ),
      digest: digest(policy["modelDigest"], "acceptance.policy.modelDigest"),
    },
    options.model,
    "MODEL_MISMATCH",
    "acceptance model",
  );
}

function evaluateValidator(
  value: JsonValue | undefined,
  options: EvaluationOptions,
): void {
  const validator = identityVersion(value, "acceptance.validator");
  if (
    validator.id !== options.validator.id ||
    validator.version !== options.validator.version
  ) {
    reject("VALIDATOR_MISMATCH", "acceptance validator does not match");
  }
}

function evaluateObjectiveGates(
  gates: readonly ObjectiveGate[],
  evidence: ReadonlyMap<string, AcceptanceEvidence>,
): void {
  for (const [index, gate] of gates.entries()) {
    if (gate.result !== "pass") {
      reject(
        "OBJECTIVE_GATE_FAILED",
        `objective gate ${index + 1} did not pass`,
      );
    }
    requireCausalGateEvidence(
      gate.evidenceRefs,
      evidence,
      `objective gate ${index + 1}`,
      gate.proofKind,
    );
  }
}

function evaluateJudge(
  value: JsonValue | undefined,
  options: EvaluationOptions,
): void {
  const judge = assertRecord(value, "acceptance.judge");
  assertExactKeys(
    judge,
    [
      "enabled",
      "version",
      "promptSha256",
      "ranAfterObjectiveGates",
      "decision",
    ],
    "acceptance.judge",
  );
  const enabled = assertBoolean(judge["enabled"], "acceptance.judge.enabled");
  const version = nonempty(judge["version"], "acceptance.judge.version");
  const promptSha256 = digest(
    judge["promptSha256"],
    "acceptance.judge.promptSha256",
  );
  const ranAfter = assertBoolean(
    judge["ranAfterObjectiveGates"],
    "acceptance.judge.ranAfterObjectiveGates",
  );
  const decision = assertString(judge["decision"], "acceptance.judge.decision");
  if (
    version !== options.judge.version ||
    promptSha256 !== options.judge.promptSha256
  ) {
    reject("JUDGE_MISMATCH", "judge version or prompt digest does not match");
  }
  if (
    (enabled && (!ranAfter || decision !== "pass")) ||
    (!enabled && (ranAfter || decision !== "not-run"))
  ) {
    reject(
      "JUDGE_ORDER_INVALID",
      "judge lifecycle does not follow objective gates",
    );
  }
}

function evaluateAuthors(value: JsonValue | undefined): void {
  const authors = assertRecord(value, "acceptance.authors");
  assertExactKeys(
    authors,
    ["author", "reviewer", "selfReview"],
    "acceptance.authors",
  );
  const author = nonempty(authors["author"], "acceptance.authors.author");
  const reviewer = nonempty(authors["reviewer"], "acceptance.authors.reviewer");
  const selfReview = assertBoolean(
    authors["selfReview"],
    "acceptance.authors.selfReview",
  );
  if (selfReview || author === reviewer) {
    reject("SELF_REVIEW", "acceptance author and reviewer must be distinct");
  }
}
