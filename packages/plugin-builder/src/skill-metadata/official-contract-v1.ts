export const SKILL_METADATA_CONTRACT_VERSION =
  "skizzles.skill-metadata/v1" as const;

export const SKILL_METADATA_CONTRACT_PROVENANCE = Object.freeze({
  observedCodexCliVersion: "0.144.5",
  artifacts: Object.freeze([
    Object.freeze({
      locator: "$CODEX_HOME/skills/.system/skill-creator/SKILL.md",
      sha256:
        // biome-ignore lint/security/noSecrets: public SHA-256 provenance digest, not a credential.
        "da44c88f6b3845a8fa8c60792ec9a722110a55a9793c279757b48fefb11f819c",
    }),
    Object.freeze({
      locator:
        "$CODEX_HOME/skills/.system/skill-creator/references/openai_yaml.md",
      sha256:
        // biome-ignore lint/security/noSecrets: public SHA-256 provenance digest, not a credential.
        "ffac39318e408108141d40f820968e59f70434a891694f9bf1d25be8237b150c",
    }),
    Object.freeze({
      locator:
        "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py",
      sha256:
        // biome-ignore lint/security/noSecrets: public SHA-256 provenance digest, not a credential.
        "6cc9dc3199c935916cf6f73fcbbbb0e3bb1b58c8f5109fefa499978908164f51",
    }),
    Object.freeze({
      locator: "official Codex manual lines 8514-8539",
      sha256:
        // biome-ignore lint/security/noSecrets: public SHA-256 provenance digest, not a credential.
        "523c876b69ad9670759e81ad7b5589e192296076e4ea48b9bc145bb76e2015c3",
    }),
  ]),
  networkLimitation:
    "Static validation approves exact declared endpoint identities only. It does not resolve DNS or attest connection-time addresses; the MCP client retains DNS, rebinding, redirect, and egress enforcement.",
  filesystemLimitation:
    "Final files are read through identity-checked no-follow descriptors. Node does not expose openat path walking here, and staging copies occur after validation; the transaction owner must guard ancestor replacement and bind copied bytes to validated bytes.",
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
