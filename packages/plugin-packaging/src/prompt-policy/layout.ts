// biome-ignore-all lint/security/noSecrets: Public upstream revisions and SHA-256 digests are deterministic provenance metadata.
export class PromptPolicyPackageError extends Error {}

import {
  PROMPT_LAYER_ASSET_ROOT,
  PROMPT_LAYER_PACKAGE_FILES,
  PROMPT_POLICY_DESCRIPTOR_PATHS,
} from "@skizzles/prompt-policy";

export const PACKAGED_PROMPT_POLICY_DESCRIPTOR =
  PROMPT_POLICY_DESCRIPTOR_PATHS.packagedPath;
export const CANONICAL_PROMPT_POLICY_DESCRIPTOR =
  PROMPT_POLICY_DESCRIPTOR_PATHS.canonicalWorkspacePath;
export const PACKAGED_APPLIED_PROMPT = "instructions/skizzles-base.md";
export const PACKAGED_PROMPT_PROVENANCE =
  "instructions/skizzles-base.provenance.json";
export const PACKAGED_DEVELOPER_INSTRUCTIONS =
  "instructions/developer-instructions.md";
export const PACKAGED_COMPACT_PROMPT = "instructions/compact-prompt.md";
export const PACKAGED_LICENSE = "third_party/openai-codex/LICENSE";
export const PACKAGED_NOTICE = "third_party/openai-codex/NOTICE";
export const EXPECTED_UPSTREAM = {
  repository: "https://github.com/openai/codex",

  commit: "bc5c9161b46feddc13282652fd2cfdf1e5bab4a9",
  path: "codex-rs/protocol/src/prompts/base_instructions/default.md",

  sha256: "ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807",
  bytes: 20_903,
} as const;
export const EXPECTED_BASELINE_ROLE =
  "pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline";
export const SOURCE_TO_PACKAGE_FILES = PROMPT_LAYER_PACKAGE_FILES;
export const PACKAGED_INSTRUCTION_FILES = [
  "compact-prompt.md",
  "developer-instructions.md",
  "skizzles-base.md",
  "skizzles-base.provenance.json",
] as const;
export const PACKAGED_OPENAI_LEGAL_FILES = ["LICENSE", "NOTICE"] as const;
export const MAINTAINER_PROMPT_PACKAGE_ROOTS = [
  "packages/prompt-policy/src",
  "packages/prompt-policy/test",
] as const;
export const MACHINE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/u,
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/u,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/iu,
];
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export { PROMPT_LAYER_ASSET_ROOT };
