export class PackagingError extends Error {}

export const PLUGIN_NAME = "skizzles";
export const REPOSITORY_URL = "https://github.com/xsyetopz/skizzles";
export const TEMPLATE_PATH = "packages/plugin-packaging/template";
export const GENERATED_PATH = `plugins/${PLUGIN_NAME}`;
export const MARKETPLACE_PATH = ".agents/plugins/marketplace.json";

export const CANONICAL_TREE_INPUTS = [["skills", "skills"]] as const;

export const CANONICAL_FILE_INPUTS = [
  ["assets/skizzles_instructions.md", "assets/skizzles_instructions.md"],
  ["assets/skizzles_subagent.toml", "assets/skizzles_subagent.toml"],
  [
    "assets/skizzles_subagent_instructions.md",
    "assets/skizzles_subagent_instructions.md",
  ],
  ["assets/agents/default.toml", "assets/agents/default.toml"],
  ["assets/agents/deployment.toml", "assets/agents/deployment.toml"],
  ["assets/agents/designer.toml", "assets/agents/designer.toml"],
  ["assets/agents/qa.toml", "assets/agents/qa.toml"],
  ["assets/agents/review.toml", "assets/agents/review.toml"],
  ["assets/agents/triage.toml", "assets/agents/triage.toml"],
  ["assets/agents/worker.toml", "assets/agents/worker.toml"],
  [
    "packages/container-lab/assets/integrations/container-lab.json",
    "integrations/container-lab.json",
  ],
  ["packages/command-routing/assets/hooks.json", "hooks/hooks.json"],
  [
    "packages/model-catalog/assets/com.openai.skizzles-model-catalog.plist",
    "assets/com.openai.skizzles-model-catalog.plist",
  ],
  [
    "packages/model-catalog/docs/installation.md",
    "assets/model-catalog-installation.md",
  ],
] as const;

export const BUNDLED_ENTRYPOINTS = [
  {
    source: "packages/command-routing/src/manage-command-output.ts",
    packageRoot: "packages/command-routing",
    destination: "hooks/manage-command-output.ts",
    label: "command hook",
  },
  {
    source: "packages/command-observation/src/codex-command.ts",
    packageRoot: "packages/command-observation",
    destination: "runtime/codex-command.ts",
    label: "command supervisor",
  },
  {
    source: "packages/model-catalog/src/index.ts",
    packageRoot: "packages/model-catalog",
    destination: "runtime/model-catalog.ts",
    label: "model catalog",
  },
  {
    source: "packages/usage-analysis/src/main.ts",
    packageRoot: "packages/usage-analysis",
    destination: "scripts/analyze.ts",
    label: "usage analyzer",
  },
  {
    source: "packages/installer/src/cli.ts",
    packageRoot: "packages/installer",
    destination: "packages/installer/src/cli.ts",
    label: "installer",
  },
] as const;

export const BLOCKED_NAMES = new Set([
  ".DS_Store",
  ".env",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "node_modules",
]);
export const SKIPPED_WORKSPACE_DIRECTORIES = new Set(["dist", "node_modules"]);
export const BLOCKED_SUFFIXES = [".db", ".log", ".sqlite", ".sqlite3"];
export const BLOCKED_CREDENTIAL_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "service-account.json",
]);
export const MACHINE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/u,
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/u,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/iu,
];
export const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
export const PLUGIN_ROOT_TOKEN = ["$", "{", "PLUGIN_ROOT", "}"].join("");
export const RELATIVE_MODULE_PATTERN = /^\.\.?\//u;
export const WORKSPACE_MODULE_PATTERN = /^@skizzles\/[a-z0-9-]+(?:\/.*)?$/u;
export const INSTALLER_SMOKE_TIMEOUT_MS = 1000;
export const INSTALLER_SMOKE_TERM_GRACE_MS = 150;
export const INSTALLER_SMOKE_OUTPUT_LIMIT = 8192;
export const INSTALLER_PUBLIC_USAGE_PREFIX = "usage: skizzles-installer ";
export const INSTALLER_CANONICAL_SOURCE_PATH = "packages/installer/src/cli.ts";
