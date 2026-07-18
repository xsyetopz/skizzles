import { evaluateAcceptance } from "./acceptance.ts";
import { evaluateContextEnvelope } from "./context-envelope.ts";
import type {
  AgentContractKind,
  EvaluationOptions,
} from "./evaluation-contract.ts";
import { evaluateHandoffReview } from "./handoff-review.ts";
import type { JsonValue } from "./json-value.ts";

export function evaluateAgentContract(
  kind: AgentContractKind,
  value: JsonValue,
  options: EvaluationOptions,
): void {
  if (kind === "context-envelope") {
    evaluateContextEnvelope(value, options);
    return;
  }
  if (kind === "handoff-review") {
    evaluateHandoffReview(value, options);
    return;
  }
  evaluateAcceptance(value, options);
}
