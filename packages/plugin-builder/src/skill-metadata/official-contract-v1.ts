// biome-ignore-all lint/security/noSecrets: pinned public commit and SHA-256 provenance digests are not credentials.
export const SKILL_METADATA_CONTRACT_VERSION =
  "skizzles.skill-metadata/v1" as const;

export const SKILL_METADATA_CONTRACT_PROVENANCE = Object.freeze({
  observedCodexCliVersion: "0.144.5",
  executableSource: Object.freeze({
    commit: "87db9bc18ba5bc82c1cb4e4381b44f693ee35623",
    repository: "https://github.com/openai/codex",
    tag: "rust-v0.144.5",
  }),
  artifacts: Object.freeze([
    Object.freeze({
      locator: "$CODEX_HOME/skills/.system/skill-creator/SKILL.md",
      sha256:
        "da44c88f6b3845a8fa8c60792ec9a722110a55a9793c279757b48fefb11f819c",
    }),
    Object.freeze({
      locator:
        "$CODEX_HOME/skills/.system/skill-creator/references/openai_yaml.md",
      sha256:
        "ffac39318e408108141d40f820968e59f70434a891694f9bf1d25be8237b150c",
    }),
    Object.freeze({
      locator:
        "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py",
      sha256:
        "6cc9dc3199c935916cf6f73fcbbbb0e3bb1b58c8f5109fefa499978908164f51",
    }),
    Object.freeze({
      locator: "official Codex manual lines 8514-8539",
      sha256:
        "523c876b69ad9670759e81ad7b5589e192296076e4ea48b9bc145bb76e2015c3",
    }),
    Object.freeze({
      locator: "openai/codex@rust-v0.144.5:codex-rs/core-skills/src/loader.rs",
      sha256:
        "acc354079afe6adddf60a96f848f9e923af889822b8958456b58f7ba9c8a69e2",
    }),
    Object.freeze({
      locator:
        "openai/codex@rust-v0.144.5:codex-rs/core-skills/src/injection.rs",
      sha256:
        "5ddef9da885d91e8882b9a6e059bd5914f6f9fe42b4ecf4efc1699f912d1fabe",
    }),
    Object.freeze({
      locator: "openai/codex@rust-v0.144.5:codex-rs/core-skills/src/model.rs",
      sha256:
        "23360b3d490b614ba932336ff7bcc1548e9ac42e90220d85657051464eaa1150",
    }),
    Object.freeze({
      locator: "openai/codex@rust-v0.144.5:codex-rs/protocol/src/protocol.rs",
      sha256:
        "375808be883656cf1d1e2fe591696ac547b20f90362ac8f17ce61eb9031e4bc3",
    }),
  ]),
  networkLimitation:
    "Static validation approves exact declared endpoint identities only. It does not resolve DNS or attest connection-time addresses; the MCP client retains DNS, rebinding, redirect, and egress enforcement.",
  filesystemLimitation:
    "Files are read through no-follow descriptors when the host exposes O_NOFOLLOW, with root/ancestor/leaf identity and realpath containment revalidated after each read. The fallback uses the same identity and containment checks. Without openat-style directory descriptors, a privileged or kernel-level hostile writer remains outside the validator threat model.",
  repositoryNarrowing:
    "Codex 0.144.5 runtime accepts short_description through 1024 characters and generally ignores unknown metadata fields. This repository deliberately requires quoted strings, exact known fields, 25-64 character short descriptions, unique products, and closed approved MCP network or local-command identities for deterministic authoring and supply-chain safety.",
  version: SKILL_METADATA_CONTRACT_VERSION,
});

export interface ApprovedMcpEndpoint {
  url: string;
  value: string;
}

export const APPROVED_MCP_ENDPOINTS: readonly ApprovedMcpEndpoint[] =
  Object.freeze([
    Object.freeze({
      url: "https://developers.openai.com/mcp",
      value: "openaiDeveloperDocs",
    }),
    Object.freeze({
      url: "https://api.githubcopilot.com/mcp/",
      value: "github",
    }),
  ]);

export const APPROVED_LOCAL_MCP_COMMANDS = Object.freeze([
  Object.freeze({ command: "gh-mcp", value: "local-gh" }),
]);
