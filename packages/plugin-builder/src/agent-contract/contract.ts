export class AgentContractPackageError extends Error {}

export const CONTRACT_SCHEMA_VERSION = "2.0.0";
export const CONTRACT_CORPUS_VERSION = "2.0.0";

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
    // biome-ignore lint/security/noSecrets: Public schema SHA-256 pin, not a credential.
    "7b741e01b0efd12b5eb4e9192784817839c6705a25506f868ee8230f28685e7f",
  "skills/fourth-wall/contracts/context-envelope.schema.json":
    // biome-ignore lint/security/noSecrets: Public schema SHA-256 pin, not a credential.
    "f23b35214bca3152bf657abde8b850d540c15ab9a4ddfbf13017b5f59ef96388",
  "skills/fourth-wall/contracts/handoff-review.schema.json":
    // biome-ignore lint/security/noSecrets: Public schema SHA-256 pin, not a credential.
    "40d3fcec9a95c79b855e02bfc27ca7acb68f2f6e8b71ebc11b42257891740444",
} as const;
