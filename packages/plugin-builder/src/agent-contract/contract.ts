export class AgentContractPackageError extends Error {}

export const CONTRACT_SCHEMA_VERSION = "3.0.0";
export const CONTRACT_CORPUS_VERSION = "3.0.0";

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

export const PINNED_SCHEMA_DIGESTS = {
  "skills/completion-contract/contracts/acceptance.schema.json":
    "238b29b5d0f9e5b7b2b1018ffefcb472edf86b1be28add634c8c22801a04a0ae",
  "skills/fourth-wall/contracts/context-envelope.schema.json":
    "b5484817093732b5aa41699b24bc2a09b607bc9a16b0d991e084edcc3bc9322f",
  "skills/fourth-wall/contracts/handoff-review.schema.json":
    "7eaf35d2ea0d77f7bcc7d65f1a201c9e0f279c8c4020cd5e1439cf46f59e6a7a",
} as const;
