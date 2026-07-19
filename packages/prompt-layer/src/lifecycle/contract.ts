/** Stable public and persistence contracts for prompt lifecycle operations. */
export const PROMPT_SCHEMA = "skizzles.prompt-layer";
export const PROMPT_SCHEMA_VERSION = 1;
export const OFFICIAL_REPOSITORY = "https://github.com/openai/codex";
export const UPSTREAM_PATH =
  "codex-rs/protocol/src/prompts/base_instructions/default.md";

export const PROMPT_LAYER_ASSET_ROOT = "packages/prompt-layer/assets";
export const PROMPT_LAYER_SOURCE_PATHS = {
  manifest: "packages/prompt-layer/assets/manifest.json",
  baseline: "packages/prompt-layer/assets/upstream/default.md",
  license: "packages/prompt-layer/assets/upstream/LICENSE",
  notice: "packages/prompt-layer/assets/upstream/NOTICE",
  patch: "packages/prompt-layer/assets/skizzles-base.patch",
  applied: "packages/prompt-layer/assets/instructions/skizzles-base.md",
  provenance:
    "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
  developer:
    "packages/prompt-layer/assets/instructions/developer-instructions.md",
  compact: "packages/prompt-layer/assets/instructions/compact-prompt.md",
  descriptor: "packages/prompt-layer/assets/integrations/prompt-policy.json",
  shippedLanguagePolicy:
    "packages/prompt-layer/assets/evaluations/shipped-language-policy.v2.json",
} as const;

export const PROMPT_POLICY_DESCRIPTOR_PATHS = {
  canonicalWorkspacePath: PROMPT_LAYER_SOURCE_PATHS.descriptor,
  packagedPath: "integrations/prompt-policy.json",
} as const;

export const SHIPPED_LANGUAGE_POLICY_PATHS = {
  canonicalWorkspacePath: PROMPT_LAYER_SOURCE_PATHS.shippedLanguagePolicy,
  packagedPath: "evaluations/shipped-language-policy.v2.json",
} as const;

export const PROMPT_LAYER_PACKAGE_FILES = [
  [PROMPT_LAYER_SOURCE_PATHS.applied, "instructions/skizzles-base.md"],
  [
    PROMPT_LAYER_SOURCE_PATHS.provenance,
    "instructions/skizzles-base.provenance.json",
  ],
  [
    PROMPT_LAYER_SOURCE_PATHS.developer,
    "instructions/developer-instructions.md",
  ],
  [PROMPT_LAYER_SOURCE_PATHS.compact, "instructions/compact-prompt.md"],
  [
    SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath,
    SHIPPED_LANGUAGE_POLICY_PATHS.packagedPath,
  ],
  [
    PROMPT_POLICY_DESCRIPTOR_PATHS.canonicalWorkspacePath,
    PROMPT_POLICY_DESCRIPTOR_PATHS.packagedPath,
  ],
  [PROMPT_LAYER_SOURCE_PATHS.license, "third_party/openai-codex/LICENSE"],
  [PROMPT_LAYER_SOURCE_PATHS.notice, "third_party/openai-codex/NOTICE"],
] as const;

export const MANIFEST_PATH = PROMPT_LAYER_SOURCE_PATHS.manifest;
export const BASELINE_PATH = PROMPT_LAYER_SOURCE_PATHS.baseline;
export const LICENSE_PATH = PROMPT_LAYER_SOURCE_PATHS.license;
export const NOTICE_PATH = PROMPT_LAYER_SOURCE_PATHS.notice;
export const PATCH_PATH = PROMPT_LAYER_SOURCE_PATHS.patch;
export const OUTPUT_PATH = PROMPT_LAYER_SOURCE_PATHS.applied;
export const PROVENANCE_PATH = PROMPT_LAYER_SOURCE_PATHS.provenance;
export const TRANSACTION_PATH = "packages/prompt-layer/assets/.transaction";
export const TRANSACTION_JOURNAL_PATH = `${TRANSACTION_PATH}/journal.json`;
export const LOCK_PATH = "packages/prompt-layer/assets/.mutation-lock";
export const LOCK_OWNER_PATH = `${LOCK_PATH}/owner.json`;

export const TRANSACTION_PATHS = {
  build: [OUTPUT_PATH, PROVENANCE_PATH],
  author: [PATCH_PATH, MANIFEST_PATH, OUTPUT_PATH, PROVENANCE_PATH],
  rebase: [
    BASELINE_PATH,
    LICENSE_PATH,
    NOTICE_PATH,
    PATCH_PATH,
    MANIFEST_PATH,
    OUTPUT_PATH,
    PROVENANCE_PATH,
  ],
} as const;

export const CANONICAL_PATHS = [
  ...TRANSACTION_PATHS.rebase,
  SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath,
] as const;

export interface FileFact {
  path: string;
  sha256: string;
  bytes: number;
}

export interface PromptManifest {
  schema: string;
  version: number;
  upstream: {
    repository: string;
    commit: string;
    path: string;
    baseline: FileFact;
    license: FileFact;
    notice: FileFact;
  };
  patch: FileFact;
  output: FileFact;
  provenance: { path: string };
}

export interface GeneratedPrompt {
  output: Buffer;
  provenance: Buffer;
}

export interface WriteEntry {
  path: string;
  bytes: Buffer;
}

export type TransactionOperation = keyof typeof TRANSACTION_PATHS;

export interface FetchResponse {
  status: number;
  body: Uint8Array;
}

export type PromptFetcher = (url: string) => Promise<FetchResponse>;

export interface TransactionFault {
  promotionIndex: number;
  simulateCrash?: boolean;
}

export interface MutationLockHooks {
  afterAcquire?: () => Promise<void>;
  beforeOwnerWrite?: () => Promise<void>;
  afterStaleQuarantine?: (lockPath: string) => Promise<void>;
  afterReleaseQuarantine?: (releasePath: string) => Promise<void>;
}

export interface ProcessIdentityProvider {
  processStartIdentity(pid: number): Promise<string | undefined>;
}

export interface MutationOptions {
  lockHooks?: MutationLockHooks;
  processIdentityProvider?: ProcessIdentityProvider;
  incompleteLockGraceMs?: number;
  signal?: AbortSignal;
}

export class PromptLayerError extends Error {}

export class SimulatedTransactionCrash extends Error {}

export function isTransactionOperation(
  value: string,
): value is TransactionOperation {
  return value === "build" || value === "author" || value === "rebase";
}
