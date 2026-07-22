import {
  type AgentContractKind,
  asInstanceEvaluation,
  ContractRejection,
  parseEvaluationOptions,
  type RejectionCode,
} from "./evaluation/contract.ts";
import { evaluateAgentContract as dispatchAgentContract } from "./evaluation/dispatch.ts";
import type { JsonValue } from "./json/value.ts";

/**
 * Evaluates one versioned agent contract through the production trust boundary.
 * Evaluation options remain JSON so every independent caller receives the same
 * strict parsing, exact-key checks, and deterministic rejection semantics.
 */
export function evaluateAgentContract(
  kind: AgentContractKind,
  input: JsonValue,
  options: JsonValue,
): void {
  asInstanceEvaluation(() => {
    if (
      kind !== "acceptance" &&
      kind !== "context-envelope" &&
      kind !== "handoff-review"
    ) {
      throw new ContractRejection(
        "INSTANCE_SHAPE",
        "agent contract kind is unsupported",
      );
    }
    dispatchAgentContract(kind, input, parseEvaluationOptions(options));
  });
}

export type { AgentContractKind, JsonValue, RejectionCode };
export { ContractRejection };
