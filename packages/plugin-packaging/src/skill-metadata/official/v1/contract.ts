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
    "Codex 0.144.5 runtime accepts short_description through 1024 characters, plugin-shared parent icon paths, and arbitrary dependency identity strings, and generally ignores unknown metadata fields. This repository deliberately requires quoted strings, exact known fields, 25-64 character short descriptions, skill-local assets paths, unique products, and closed approved bare MCP, network MCP, local-command MCP, or CLI identities for deterministic authoring and supply-chain safety.",
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

export const APPROVED_BARE_MCP_IDENTITIES = Object.freeze([
  "github",
  "openaiDeveloperDocs",
]);

export const APPROVED_CLI_IDENTITIES = Object.freeze(["gh"]);

export interface SkillMetadataFixtureBinding {
  file: string;
  sha256: string;
}

export const SKILL_METADATA_FIXTURE_BINDINGS: readonly SkillMetadataFixtureBinding[] =
  Object.freeze([
    Object.freeze({
      file: "official/valid/SKILL.md",
      sha256:
        "5e113d5e58f0eb36d43ac39dd4f50daf840eaddcff9c3b1cc1a016f30f1e5579",
    }),
    Object.freeze({
      file: "official/invalid-description/SKILL.md",
      sha256:
        "9f4d44352df38433e7fc1d022d8dc76a2228778159189605c932b1978f48720b",
    }),
    Object.freeze({
      file: "official/valid/openai.yaml",
      sha256:
        "9f06af1a8469f02f6595de2aac361cd8a0770e31f6bcf2808b096ce0db5cdcbc",
    }),
    Object.freeze({
      file: "runtime/valid/openai.yaml",
      sha256:
        "8ecbe663e6167177f5b84fe489f38daf26888a0e3d0a065022e6732334a4aed0",
    }),
    Object.freeze({
      file: "runtime/invalid/openai.yaml",
      sha256:
        "990e8f47f7528eaec082a099f841ba70c9f3f2a94ff2dc9e4505eddb2ee051b9",
    }),
  ]);

export function assertExactSkillMetadataFixtureBindings(
  value: unknown,
): asserts value is readonly SkillMetadataFixtureBinding[] {
  if (
    JSON.stringify(value) !== JSON.stringify(SKILL_METADATA_FIXTURE_BINDINGS)
  ) {
    throw new Error(
      "Skill metadata fixture bindings differ from the pinned inventory.",
    );
  }
}
