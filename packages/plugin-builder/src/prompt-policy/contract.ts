import { PROMPT_LAYER_SOURCE_PATHS } from "@skizzles/prompt-layer";
import {
  readFixedPolicyFile,
  rejectMachinePath,
  validateCanonicalText,
} from "./file-containment.ts";
import {
  EXPECTED_BASELINE_ROLE,
  EXPECTED_UPSTREAM,
  PACKAGED_APPLIED_PROMPT,
  PACKAGED_COMPACT_PROMPT,
  PACKAGED_DEVELOPER_INSTRUCTIONS,
  PACKAGED_LICENSE,
  PACKAGED_NOTICE,
  PACKAGED_PROMPT_PROVENANCE,
  PromptPolicyPackageError,
  SHA256_PATTERN,
} from "./layout.ts";

export interface IntegrityFact {
  sha256: string;
  bytes: number;
}

export interface FileFact extends IntegrityFact {
  path: string;
}

export interface LegalFact extends IntegrityFact {
  sourcePath: string;
  packagedPath: string;
}

export interface UpstreamFact extends IntegrityFact {
  repository: string;
  commit: string;
  path: string;
}

export interface PromptManifestContract {
  upstream: UpstreamFact;
  patch: FileFact;
  output: FileFact;
  provenancePath: string;
  license: FileFact;
  notice: FileFact;
}

export interface PromptPolicyContract {
  role: string;
  applied: FileFact;
  provenance: FileFact;
  developer: FileFact;
  compact: FileFact;
  upstream: UpstreamFact;
  license: LegalFact;
  notice: LegalFact;
}

export async function readPromptManifest(
  sourceRoot: string,
): Promise<PromptManifestContract> {
  const bytes = await readFixedPolicyFile(
    sourceRoot,
    PROMPT_LAYER_SOURCE_PATHS.manifest,
    "prompt-layer manifest",
  );
  validateCanonicalText(bytes, "prompt-layer manifest");
  rejectMachinePath(bytes, "prompt-layer manifest");
  const manifest = parseJsonObject(bytes, "prompt-layer manifest");
  exactKeys(
    manifest,
    ["schema", "version", "upstream", "patch", "output", "provenance"],
    "prompt-layer manifest",
  );
  if (
    manifest["schema"] !== "skizzles.prompt-layer" ||
    manifest["version"] !== 1
  ) {
    throw new PromptPolicyPackageError(
      "Unsupported prompt-layer manifest schema or version.",
    );
  }

  const upstreamValue = requiredObject(
    manifest["upstream"],
    "prompt-layer manifest upstream",
  );
  exactKeys(
    upstreamValue,
    ["repository", "commit", "path", "baseline", "license", "notice"],
    "prompt-layer manifest upstream",
  );
  const baseline = parseManifestFileFact(
    upstreamValue["baseline"],
    "prompt-layer manifest baseline",
  );
  const license = parseManifestFileFact(
    upstreamValue["license"],
    "prompt-layer manifest LICENSE",
  );
  const notice = parseManifestFileFact(
    upstreamValue["notice"],
    "prompt-layer manifest NOTICE",
  );
  const patch = parseManifestFileFact(
    manifest["patch"],
    "prompt-layer manifest patch",
  );
  const output = parseManifestFileFact(
    manifest["output"],
    "prompt-layer manifest output",
  );
  const provenanceValue = requiredObject(
    manifest["provenance"],
    "prompt-layer manifest provenance",
  );
  exactKeys(provenanceValue, ["path"], "prompt-layer manifest provenance");
  const provenancePath = requiredPortablePath(
    provenanceValue["path"],
    "prompt-layer manifest provenance path",
  );
  const upstream: UpstreamFact = {
    repository: requiredString(
      upstreamValue["repository"],
      "prompt-layer manifest upstream repository",
    ),
    commit: requiredString(
      upstreamValue["commit"],
      "prompt-layer manifest upstream commit",
    ),
    path: requiredPortablePath(
      upstreamValue["path"],
      "prompt-layer manifest upstream path",
    ),
    sha256: baseline.sha256,
    bytes: baseline.bytes,
  };
  if (
    upstream.repository !== EXPECTED_UPSTREAM.repository ||
    upstream.commit !== EXPECTED_UPSTREAM.commit ||
    upstream.path !== EXPECTED_UPSTREAM.path ||
    upstream.sha256 !== EXPECTED_UPSTREAM.sha256 ||
    upstream.bytes !== EXPECTED_UPSTREAM.bytes ||
    baseline.path !== PROMPT_LAYER_SOURCE_PATHS.baseline ||
    license.path !== PROMPT_LAYER_SOURCE_PATHS.license ||
    notice.path !== PROMPT_LAYER_SOURCE_PATHS.notice ||
    patch.path !== PROMPT_LAYER_SOURCE_PATHS.patch ||
    output.path !== PROMPT_LAYER_SOURCE_PATHS.applied ||
    provenancePath !== PROMPT_LAYER_SOURCE_PATHS.provenance
  ) {
    throw new PromptPolicyPackageError(
      "Prompt-layer manifest does not match the pinned packaging contract.",
    );
  }
  return { upstream, patch, output, provenancePath, license, notice };
}

export function parsePromptPolicyContract(
  descriptor: Record<string, unknown>,
): PromptPolicyContract {
  exactKeys(
    descriptor,
    ["schema", "version", "base", "developerInstructions", "compactPrompt"],
    "prompt-policy descriptor",
  );
  if (
    descriptor["schema"] !== "skizzles.prompt-policy" ||
    descriptor["version"] !== 1
  ) {
    throw new PromptPolicyPackageError(
      "Unsupported prompt-policy descriptor schema or version.",
    );
  }
  const base = requiredObject(descriptor["base"], "prompt-policy base");
  exactKeys(
    base,
    ["role", "applied", "provenance", "upstream", "legal"],
    "prompt-policy base",
  );
  const upstream = parseUpstreamFact(
    base["upstream"],
    "prompt-policy upstream",
  );
  const legal = requiredObject(base["legal"], "prompt-policy legal inputs");
  exactKeys(legal, ["license", "notice"], "prompt-policy legal inputs");
  return {
    role: requiredString(base["role"], "prompt-policy base role"),
    applied: parseFileFact(base["applied"], "applied prompt"),
    provenance: parseFileFact(base["provenance"], "prompt provenance"),
    developer: parseFileFact(
      descriptor["developerInstructions"],
      "developer instructions",
    ),
    compact: parseFileFact(descriptor["compactPrompt"], "compact prompt"),
    upstream,
    license: parseLegalFact(legal["license"], "prompt-policy LICENSE"),
    notice: parseLegalFact(legal["notice"], "prompt-policy NOTICE"),
  };
}

export function assertPolicyMatchesManifest(
  policy: PromptPolicyContract,
  manifest: PromptManifestContract,
): void {
  if (
    policy.role !== EXPECTED_BASELINE_ROLE ||
    policy.applied.path !== PACKAGED_APPLIED_PROMPT ||
    policy.provenance.path !== PACKAGED_PROMPT_PROVENANCE ||
    policy.developer.path !== PACKAGED_DEVELOPER_INSTRUCTIONS ||
    policy.compact.path !== PACKAGED_COMPACT_PROMPT ||
    !sameUpstream(policy.upstream, manifest.upstream) ||
    !sameIntegrity(policy.applied, manifest.output) ||
    policy.license.sourcePath !== PROMPT_LAYER_SOURCE_PATHS.license ||
    policy.license.packagedPath !== PACKAGED_LICENSE ||
    !sameIntegrity(policy.license, manifest.license) ||
    policy.notice.sourcePath !== PROMPT_LAYER_SOURCE_PATHS.notice ||
    policy.notice.packagedPath !== PACKAGED_NOTICE ||
    !sameIntegrity(policy.notice, manifest.notice)
  ) {
    throw new PromptPolicyPackageError(
      "Prompt-policy descriptor does not match the pinned prompt-layer manifest.",
    );
  }
}

export function validatePromptProvenance(
  provenance: Record<string, unknown>,
  policy: PromptPolicyContract,
  manifest: PromptManifestContract,
): void {
  exactKeys(
    provenance,
    [
      "schema",
      "version",
      "baselineRole",
      "upstream",
      "patch",
      "output",
      "legal",
    ],
    "prompt provenance",
  );
  const upstream = parseUpstreamFact(
    provenance["upstream"],
    "prompt provenance upstream",
  );
  const patch = parseIntegrityFact(
    provenance["patch"],
    "prompt provenance patch",
  );
  const output = parseIntegrityFact(
    provenance["output"],
    "prompt provenance output",
  );
  const legal = requiredObject(provenance["legal"], "prompt provenance legal");
  exactKeys(legal, ["license", "notice"], "prompt provenance legal");
  const license = parseIntegrityFact(
    legal["license"],
    "prompt provenance LICENSE",
  );
  const notice = parseIntegrityFact(
    legal["notice"],
    "prompt provenance NOTICE",
  );
  if (
    provenance["schema"] !== "skizzles.prompt-layer" ||
    provenance["version"] !== 1 ||
    provenance["baselineRole"] !== EXPECTED_BASELINE_ROLE ||
    provenance["baselineRole"] !== policy.role ||
    !sameUpstream(upstream, manifest.upstream) ||
    !sameIntegrity(patch, manifest.patch) ||
    !sameIntegrity(output, manifest.output) ||
    !sameIntegrity(output, policy.applied) ||
    !sameIntegrity(license, manifest.license) ||
    !sameIntegrity(license, policy.license) ||
    !sameIntegrity(notice, manifest.notice) ||
    !sameIntegrity(notice, policy.notice)
  ) {
    throw new PromptPolicyPackageError(
      "Prompt provenance does not match the pinned prompt-layer manifest and policy descriptor.",
    );
  }
}

function parseManifestFileFact(value: unknown, label: string): FileFact {
  return parseFileFact(value, label);
}

function parseFileFact(value: unknown, label: string): FileFact {
  const fact = requiredObject(value, label);
  exactKeys(fact, ["path", "sha256", "bytes"], label);
  return {
    path: requiredPortablePath(fact["path"], `${label} path`),
    ...parseIntegrityValues(fact, label),
  };
}

function parseLegalFact(value: unknown, label: string): LegalFact {
  const fact = requiredObject(value, label);
  exactKeys(fact, ["sourcePath", "packagedPath", "sha256", "bytes"], label);
  return {
    sourcePath: requiredPortablePath(
      fact["sourcePath"],
      `${label} source path`,
    ),
    packagedPath: requiredPortablePath(
      fact["packagedPath"],
      `${label} packaged path`,
    ),
    ...parseIntegrityValues(fact, label),
  };
}

function parseUpstreamFact(value: unknown, label: string): UpstreamFact {
  const fact = requiredObject(value, label);
  exactKeys(fact, ["repository", "commit", "path", "sha256", "bytes"], label);
  return {
    repository: requiredString(fact["repository"], `${label} repository`),
    commit: requiredString(fact["commit"], `${label} commit`),
    path: requiredPortablePath(fact["path"], `${label} path`),
    ...parseIntegrityValues(fact, label),
  };
}

function parseIntegrityFact(value: unknown, label: string): IntegrityFact {
  const fact = requiredObject(value, label);
  exactKeys(fact, ["sha256", "bytes"], label);
  return parseIntegrityValues(fact, label);
}

function parseIntegrityValues(
  fact: Record<string, unknown>,
  label: string,
): IntegrityFact {
  const sha256 = fact["sha256"];
  const bytes = fact["bytes"];
  if (
    typeof sha256 !== "string" ||
    !SHA256_PATTERN.test(sha256) ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0
  ) {
    throw new PromptPolicyPackageError(`${label} has invalid integrity facts.`);
  }
  return {
    sha256,
    bytes,
  };
}

export function parseJsonObject(
  bytes: Buffer,
  label: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PromptPolicyPackageError(`${label} is not valid JSON.`);
  }
  if (!isObject(value)) {
    throw new PromptPolicyPackageError(`${label} must contain a JSON object.`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")
  ) {
    throw new PromptPolicyPackageError(
      `${label} has unexpected or missing fields.`,
    );
  }
}

function requiredObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isObject(value)) {
    throw new PromptPolicyPackageError(`${label} must be an object.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PromptPolicyPackageError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredPortablePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new PromptPolicyPackageError(`${label} must be a portable path.`);
  }
  return path;
}

function sameIntegrity(left: IntegrityFact, right: IntegrityFact): boolean {
  return left.sha256 === right.sha256 && left.bytes === right.bytes;
}

function sameUpstream(left: UpstreamFact, right: UpstreamFact): boolean {
  return (
    left.repository === right.repository &&
    left.commit === right.commit &&
    left.path === right.path &&
    sameIntegrity(left, right)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
