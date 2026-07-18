import { posix } from "node:path";

const TOOL_NAMES = ["actionlint", "shellcheck", "gitleaks"] as const;
const SUPPORTED_TARGETS = ["linux-x64", "darwin-arm64"] as const;

type SecurityToolName = (typeof TOOL_NAMES)[number];
type SecurityToolTarget = (typeof SUPPORTED_TARGETS)[number];

interface SecurityToolProvenance {
  repository: string;
  tag: string;
  commit: string;
}

interface SecurityToolAsset {
  url: string;
  sha256: string;
  executablePath: string;
  githubReleaseAsset: GitHubReleaseAssetEvidence;
}

interface GitHubReleaseAssetEvidence {
  releaseApiUrl: string;
  releaseId: number;
  assetId: number;
  bytes: number;
  updatedAt: string;
  digest: string;
}

interface SecurityToolSpec {
  name: SecurityToolName;
  version: string;
  license: string;
  provenance: SecurityToolProvenance;
  versionCommand: readonly string[];
  versionOutputPattern: string;
  assets: Readonly<Record<SecurityToolTarget, SecurityToolAsset>>;
}

interface RepositorySecurityToolManifest {
  schemaVersion: 1;
  tools: Readonly<Record<SecurityToolName, SecurityToolSpec>>;
}

function validateArchiveMemberPath(path: string, label: string): void {
  if (
    path === "" ||
    path.includes("\\") ||
    path.includes("\0") ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a normalized contained archive path`);
  }
}

export type {
  GitHubReleaseAssetEvidence,
  RepositorySecurityToolManifest,
  SecurityToolAsset,
  SecurityToolName,
  SecurityToolProvenance,
  SecurityToolSpec,
  SecurityToolTarget,
};
export { SUPPORTED_TARGETS, TOOL_NAMES, validateArchiveMemberPath };
