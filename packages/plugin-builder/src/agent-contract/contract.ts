import { join } from "node:path";

export class AgentContractPackageError extends Error {}

export const JSON_SCHEMA_DIALECT =
  "https://json-schema.org/draft/2020-12/schema";
export const CONTRACT_SCHEMA_VERSION = "1.0.0";
export const CONTRACT_CORPUS_VERSION = "1.0.0";

export const AGENT_CONTRACT_ASSETS = [
  {
    kind: "schema",
    owner: "Fourth Wall",
    canonicalPath: "skills/fourth-wall/contracts/context-envelope.schema.json",
    stagedPath: "skills/fourth-wall/contracts/context-envelope.schema.json",
  },
  {
    kind: "schema",
    owner: "Fourth Wall",
    canonicalPath: "skills/fourth-wall/contracts/handoff-review.schema.json",
    stagedPath: "skills/fourth-wall/contracts/handoff-review.schema.json",
  },
  {
    kind: "corpus",
    owner: "Fourth Wall",
    canonicalPath: "skills/fourth-wall/fixtures/trust-boundary-incidents.json",
    stagedPath: "skills/fourth-wall/fixtures/trust-boundary-incidents.json",
  },
  {
    kind: "schema",
    owner: "Completion Contract",
    canonicalPath:
      "skills/completion-contract/contracts/acceptance.schema.json",
    stagedPath: "skills/completion-contract/contracts/acceptance.schema.json",
  },
  {
    kind: "corpus",
    owner: "Completion Contract",
    canonicalPath:
      "skills/completion-contract/fixtures/acceptance-incidents.json",
    stagedPath: "skills/completion-contract/fixtures/acceptance-incidents.json",
  },
] as const;

export type AgentContractAsset = (typeof AGENT_CONTRACT_ASSETS)[number];

export const SCHEMA_IDS = {
  acceptance:
    "https://xsyetopz.github.io/skizzles/contracts/acceptance/v1.schema.json",
  contextEnvelope:
    "https://xsyetopz.github.io/skizzles/contracts/context-envelope/v1.schema.json",
  handoffReview:
    "https://xsyetopz.github.io/skizzles/contracts/handoff-review/v1.schema.json",
} as const;

export const CORPUS_CASES = {
  acceptance: [
    ["CC-001", "verifier-mutation", "verifier-mutation"],
    ["CC-002", "solution-leakage", "solution-leakage"],
    ["CC-003", "grader-injection", "grader-injection"],
    ["CC-004", "hard-coded-answer", "hard-coded-answer"],
    ["CC-005", "fake-effect", "fake-effect"],
    [
      "CC-006",
      "exit-zero-success-token-spoof",
      "exit-zero-success-token-spoof",
    ],
    ["CC-007", "deceptive-completion", "deceptive-completion"],
  ],
  trustBoundary: [
    ["FW-001", "malformed", "missing-objective"],
    ["FW-002", "absent", "missing-validation"],
    ["FW-003", "stale", "expired-policy"],
    ["FW-004", "expired", "expired-retention"],
    ["FW-005", "redacted", "secret-without-redaction"],
    ["FW-006", "transformed-unvalidated", "summary-status-unvalidated"],
    ["FW-007", "version-mismatch", "policy-digest-mismatch"],
    ["FW-008", "context-injection", "grader-instruction-in-input"],
    ["FW-009", "self-review", "author-equals-reviewer"],
    ["FW-010", "verifier-mutation", "test-source-modified"],
    ["FW-011", "solution-leakage", "private-acceptance-answer-in-context"],
    ["FW-012", "grader-injection", "judge-prompt-override"],
    ["FW-013", "hard-coded-answer", "fixture-answer-without-causal-effect"],
    ["FW-014", "fake-effect", "mocked-privileged-action"],
    ["FW-015", "exit-zero-spoof", "success-token-with-failure"],
    ["FW-016", "deceptive-completion", "unsupported-completion-claim"],
  ],
} as const;

export function canonicalAssetPath(
  repoRoot: string,
  asset: AgentContractAsset,
): string {
  return join(repoRoot, asset.canonicalPath);
}

export function stagedAssetPath(
  pluginRoot: string,
  asset: AgentContractAsset,
): string {
  return join(pluginRoot, asset.stagedPath);
}
