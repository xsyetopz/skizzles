import { readFile } from "node:fs/promises";
import {
  type GitHubReleaseAssetEvidence,
  type RepositorySecurityToolManifest,
  type SecurityToolAsset,
  type SecurityToolName,
  type SecurityToolProvenance,
  type SecurityToolSpec,
  type SecurityToolTarget,
  SUPPORTED_TARGETS,
  TOOL_NAMES,
  validateArchiveMemberPath,
} from "./security-tool-contract.ts";
import {
  REQUIRED_TOOL_FACTS,
  type RequiredAssetFacts,
} from "./security-tool-pins.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

async function loadRepositorySecurityToolManifest(
  workspaceRoot: string,
): Promise<RepositorySecurityToolManifest> {
  const path = `${workspaceRoot}/config/repository-security-tools.json`;
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    let reason = String(error);
    if (error instanceof Error) {
      reason = error.message;
    }
    throw new Error(
      `repository security tool manifest is unreadable: ${reason}`,
      {
        cause: error,
      },
    );
  }
  return parseRepositorySecurityToolManifest(input);
}

function parseRepositorySecurityToolManifest(
  input: unknown,
): RepositorySecurityToolManifest {
  const root = record(input, "security tool manifest");
  exactKeys(root, ["schemaVersion", "tools"], "security tool manifest");
  if (root["schemaVersion"] !== 1) {
    throw new Error("security tool manifest schemaVersion must be 1");
  }
  const toolsInput = record(root["tools"], "security tool manifest tools");
  exactKeys(toolsInput, TOOL_NAMES, "security tool manifest tools");
  return {
    schemaVersion: 1,
    tools: {
      actionlint: parseTool("actionlint", toolsInput["actionlint"]),
      shellcheck: parseTool("shellcheck", toolsInput["shellcheck"]),
      gitleaks: parseTool("gitleaks", toolsInput["gitleaks"]),
    },
  };
}

function resolveSecurityToolTarget(
  platform: string,
  architecture: string,
): SecurityToolTarget {
  const target = `${platform}-${architecture}`;
  if (target === "linux-x64" || target === "darwin-arm64") {
    return target;
  }
  throw new Error(
    `repository security tools do not support platform ${platform}/${architecture}`,
  );
}

function parseTool(name: SecurityToolName, input: unknown): SecurityToolSpec {
  const label = `security tool ${name}`;
  const value = record(input, label);
  exactKeys(
    value,
    [
      "version",
      "license",
      "provenance",
      "versionCommand",
      "versionOutputPattern",
      "assets",
    ],
    label,
  );
  const facts = REQUIRED_TOOL_FACTS[name];
  const version = exactString(value["version"], `${label} version`);
  const license = exactString(value["license"], `${label} license`);
  if (version !== facts.version || license !== facts.license) {
    throw new Error(
      `${label} must remain pinned to ${facts.version} (${facts.license})`,
    );
  }
  const provenance = parseProvenance(name, value["provenance"]);
  const command = stringArray(
    value["versionCommand"],
    `${label} versionCommand`,
  );
  const pattern = exactString(
    value["versionOutputPattern"],
    `${label} versionOutputPattern`,
  );
  if (
    !sameStrings(command, facts.versionCommand) ||
    pattern !== facts.versionOutputPattern
  ) {
    throw new Error(`${label} command contract does not match immutable pins`);
  }
  try {
    new RegExp(pattern, "u").test("");
  } catch (error) {
    throw new Error(
      `${label} versionOutputPattern must be a valid expression`,
      { cause: error },
    );
  }
  const assetsInput = record(value["assets"], `${label} assets`);
  exactKeys(assetsInput, SUPPORTED_TARGETS, `${label} assets`);
  return {
    name,
    version,
    license,
    provenance,
    versionCommand: command,
    versionOutputPattern: pattern,
    assets: {
      "linux-x64": parseAsset(
        name,
        provenance,
        "linux-x64",
        assetsInput["linux-x64"],
      ),
      "darwin-arm64": parseAsset(
        name,
        provenance,
        "darwin-arm64",
        assetsInput["darwin-arm64"],
      ),
    },
  };
}

function parseProvenance(
  name: SecurityToolName,
  input: unknown,
): SecurityToolProvenance {
  const label = `security tool ${name} provenance`;
  const value = record(input, label);
  exactKeys(value, ["repository", "tag", "commit"], label);
  const repository = exactString(value["repository"], `${label} repository`);
  const tag = exactString(value["tag"], `${label} tag`);
  const commit = exactString(value["commit"], `${label} commit`);
  const facts = REQUIRED_TOOL_FACTS[name];
  if (
    repository !== facts.repository ||
    tag !== facts.tag ||
    commit !== facts.commit
  ) {
    throw new Error(`${label} does not match the pinned upstream release`);
  }
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`${label} commit must be a lowercase 40-character Git SHA`);
  }
  return { repository, tag, commit };
}

function parseAsset(
  name: SecurityToolName,
  provenance: SecurityToolProvenance,
  target: SecurityToolTarget,
  input: unknown,
): SecurityToolAsset {
  const label = `security tool ${name} ${target} asset`;
  const value = record(input, label);
  exactKeys(
    value,
    ["url", "sha256", "executablePath", "githubReleaseAsset"],
    label,
  );
  const url = exactString(value["url"], `${label} url`);
  const sha256 = exactString(value["sha256"], `${label} sha256`);
  const executablePath = exactString(
    value["executablePath"],
    `${label} executablePath`,
  );
  const assetFacts = REQUIRED_TOOL_FACTS[name].assets[target];
  if (
    url !== assetFacts.url ||
    sha256 !== assetFacts.sha256 ||
    executablePath !== assetFacts.executablePath
  ) {
    throw new Error(`${label} does not match immutable asset pins`);
  }
  const parsedUrl = new URL(url);
  const releasePrefix = `/releases/download/${provenance.tag}/`;
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    parsedUrl.pathname !==
      `/${provenance.repository}${releasePrefix}${parsedUrl.pathname.split("/").at(-1)}` ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    !parsedUrl.pathname.endsWith(".tar.gz")
  ) {
    throw new Error(`${label} url must be an official GitHub release archive`);
  }
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`${label} sha256 must be a lowercase SHA-256 digest`);
  }
  validateArchiveMemberPath(executablePath, `${label} executablePath`);
  return {
    url,
    sha256,
    executablePath,
    githubReleaseAsset: parseGitHubReleaseAsset(
      name,
      target,
      sha256,
      value["githubReleaseAsset"],
    ),
  };
}

function parseGitHubReleaseAsset(
  name: SecurityToolName,
  target: SecurityToolTarget,
  sha256: string,
  input: unknown,
): GitHubReleaseAssetEvidence {
  const label = `security tool ${name} ${target} GitHub release asset`;
  const value = record(input, label);
  exactKeys(
    value,
    ["releaseApiUrl", "releaseId", "assetId", "bytes", "updatedAt", "digest"],
    label,
  );
  const releaseApiUrl = exactString(
    value["releaseApiUrl"],
    `${label} releaseApiUrl`,
  );
  const releaseId = positiveInteger(value["releaseId"], `${label} releaseId`);
  const assetId = positiveInteger(value["assetId"], `${label} assetId`);
  const bytes = positiveInteger(value["bytes"], `${label} bytes`);
  const updatedAt = exactString(value["updatedAt"], `${label} updatedAt`);
  const digest = exactString(value["digest"], `${label} digest`);
  const assetFacts: RequiredAssetFacts =
    REQUIRED_TOOL_FACTS[name].assets[target];
  if (
    releaseApiUrl !== assetFacts.releaseApiUrl ||
    releaseId !== assetFacts.releaseId ||
    assetId !== assetFacts.assetId ||
    bytes !== assetFacts.bytes ||
    updatedAt !== assetFacts.updatedAt ||
    digest !== assetFacts.digest ||
    digest !== `sha256:${sha256}`
  ) {
    throw new Error(`${label} does not match pinned primary API evidence`);
  }
  return { releaseApiUrl, releaseId, assetId, bytes, updatedAt, digest };
}

function recordOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  const result = recordOrUndefined(value);
  if (result === undefined) {
    throw new Error(`${label} must be an object`);
  }
  return result;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} keys must be exactly ${required.join(", ")}`);
  }
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty exact string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) => typeof item !== "string" || item === "" || item.trim() !== item,
    )
  ) {
    throw new Error(`${label} must be a non-empty array of exact strings`);
  }
  return value;
}

function sameStrings(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export {
  loadRepositorySecurityToolManifest,
  parseRepositorySecurityToolManifest,
  resolveSecurityToolTarget,
};
