import type {
  AgentContractKind,
  RejectionCode,
} from "./evaluation-contract.ts";

export interface ExpectedCase {
  id: string;
  contract: AgentContractKind;
  decision: "accept" | "reject";
  code: RejectionCode | null;
}

const TRUST_CASES: readonly ExpectedCase[] = [
  {
    id: "FW-001",
    contract: "context-envelope",
    decision: "accept",
    code: null,
  },
  { id: "FW-002", contract: "handoff-review", decision: "accept", code: null },
  {
    id: "FW-003",
    contract: "context-envelope",
    decision: "reject",
    code: "INSTANCE_SHAPE",
  },
  {
    id: "FW-004",
    contract: "context-envelope",
    decision: "reject",
    code: "CONTEXT_PROPERTY_DUPLICATE",
  },
  {
    id: "FW-005",
    contract: "context-envelope",
    decision: "reject",
    code: "INTEGRITY_MISMATCH",
  },
  {
    id: "FW-006",
    contract: "context-envelope",
    decision: "reject",
    code: "LLM_TRANSFORM_UNVALIDATED",
  },
  {
    id: "FW-007",
    contract: "context-envelope",
    decision: "reject",
    code: "CONTEXT_EXPIRED",
  },
  {
    id: "FW-008",
    contract: "context-envelope",
    decision: "reject",
    code: "SECRET_REDACTION_REQUIRED",
  },
  {
    id: "FW-009",
    contract: "context-envelope",
    decision: "reject",
    code: "POLICY_MISMATCH",
  },
  {
    id: "FW-010",
    contract: "context-envelope",
    decision: "reject",
    code: "MODEL_MISMATCH",
  },
  {
    id: "FW-011",
    contract: "handoff-review",
    decision: "reject",
    code: "SELF_REVIEW",
  },
  {
    id: "FW-012",
    contract: "handoff-review",
    decision: "reject",
    code: "OBJECTIVE_MISMATCH",
  },
  {
    id: "FW-013",
    contract: "handoff-review",
    decision: "reject",
    code: "ACCEPTANCE_MISMATCH",
  },
  {
    id: "FW-014",
    contract: "handoff-review",
    decision: "reject",
    code: "REFERENCE_MISSING",
  },
  {
    id: "FW-015",
    contract: "context-envelope",
    decision: "reject",
    code: "VALIDATOR_MISMATCH",
  },
  {
    id: "FW-016",
    contract: "context-envelope",
    decision: "reject",
    code: "VALIDATOR_MISMATCH",
  },
] as const;

const ACCEPTANCE_CASES: readonly ExpectedCase[] = [
  { id: "CC-001", contract: "acceptance", decision: "accept", code: null },
  {
    id: "CC-002",
    contract: "acceptance",
    decision: "reject",
    code: "REQUIREMENT_DUPLICATE",
  },
  {
    id: "CC-003",
    contract: "acceptance",
    decision: "reject",
    code: "GATE_ORDER_INVALID",
  },
  {
    id: "CC-004",
    contract: "acceptance",
    decision: "reject",
    code: "GATE_REQUIREMENT_UNKNOWN",
  },
  {
    id: "CC-005",
    contract: "acceptance",
    decision: "reject",
    code: "RETRY_LIMIT_EXCEEDED",
  },
  {
    id: "CC-006",
    contract: "acceptance",
    decision: "reject",
    code: "JUDGE_ORDER_INVALID",
  },
  {
    id: "CC-007",
    contract: "acceptance",
    decision: "reject",
    code: "SELF_REVIEW",
  },
  {
    id: "CC-008",
    contract: "acceptance",
    decision: "reject",
    code: "VERIFIER_MUTATION",
  },
  {
    id: "CC-009",
    contract: "acceptance",
    decision: "reject",
    code: "TEST_MUTATION",
  },
  {
    id: "CC-010",
    contract: "acceptance",
    decision: "reject",
    code: "SOLUTION_LEAKAGE",
  },
  {
    id: "CC-011",
    contract: "acceptance",
    decision: "reject",
    code: "GRADER_INJECTION",
  },
  {
    id: "CC-012",
    contract: "acceptance",
    decision: "reject",
    code: "HARD_CODED_ANSWER",
  },
  {
    id: "CC-013",
    contract: "acceptance",
    decision: "reject",
    code: "FAKE_EFFECT",
  },
  {
    id: "CC-014",
    contract: "acceptance",
    decision: "reject",
    code: "EXIT_ZERO_ONLY",
  },
  {
    id: "CC-015",
    contract: "acceptance",
    decision: "reject",
    code: "SUCCESS_TOKEN_ONLY",
  },
  {
    id: "CC-016",
    contract: "acceptance",
    decision: "reject",
    code: "DECEPTIVE_COMPLETION",
  },
  {
    id: "CC-017",
    contract: "acceptance",
    decision: "reject",
    code: "EVIDENCE_BINDING_INVALID",
  },
  {
    id: "CC-018",
    contract: "acceptance",
    decision: "reject",
    code: "OBJECTIVE_GATE_FAILED",
  },
] as const;

export function expectedIncidentCases(
  corpusKind: "acceptance" | "trust-boundary",
): readonly ExpectedCase[] {
  return corpusKind === "acceptance" ? ACCEPTANCE_CASES : TRUST_CASES;
}
