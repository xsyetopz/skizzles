import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkPrompt } from "./prompt-layer.ts";

const PROMPT_LAYER_MANIFEST = "packages/core/prompt-layer/manifest.json";
const PROMPT_POLICY_DESCRIPTOR = "integrations/prompt-policy.json";
const APPLIED_PROMPT = "instructions/skizzles-base.md";
const PROMPT_PROVENANCE = "instructions/skizzles-base.provenance.json";
const DEVELOPER_INSTRUCTIONS = "instructions/developer-instructions.md";
const COMPACT_PROMPT = "instructions/compact-prompt.md";
const UPSTREAM_LICENSE = "packages/core/prompt-layer/upstream/LICENSE";
const UPSTREAM_NOTICE = "packages/core/prompt-layer/upstream/NOTICE";
const PACKAGED_LICENSE = "third_party/openai-codex/LICENSE";
const PACKAGED_NOTICE = "third_party/openai-codex/NOTICE";
const PROMPT_PATCH = "packages/core/prompt-layer/skizzles-base.patch";
const UPSTREAM_BASELINE = "packages/core/prompt-layer/upstream/default.md";
const EXPECTED_UPSTREAM = {
  repository: "https://github.com/openai/codex",
  commit: "bc5c9161b46feddc13282652fd2cfdf1e5bab4a9",
  path: "codex-rs/protocol/src/prompts/base_instructions/default.md",
  sha256: "ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807",
  bytes: 20_903,
} as const;
const EXPECTED_BASELINE_ROLE =
  "pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline";
const SOURCE_TO_PACKAGE_FILES = [
  [APPLIED_PROMPT, APPLIED_PROMPT],
  [PROMPT_PROVENANCE, PROMPT_PROVENANCE],
  [DEVELOPER_INSTRUCTIONS, DEVELOPER_INSTRUCTIONS],
  [COMPACT_PROMPT, COMPACT_PROMPT],
  [UPSTREAM_LICENSE, PACKAGED_LICENSE],
  [UPSTREAM_NOTICE, PACKAGED_NOTICE],
] as const;
const PACKAGED_INSTRUCTION_FILES = [
  "compact-prompt.md",
  "developer-instructions.md",
  "skizzles-base.md",
  "skizzles-base.provenance.json",
] as const;
const PACKAGED_OPENAI_LEGAL_FILES = ["LICENSE", "NOTICE"] as const;
const FORBIDDEN_PROMPT_TOOLING_SUFFIXES = [
  "packages/core/src/prompt-layer.ts",
  "packages/core/test/prompt-layer.test.ts",
] as const;
const MACHINE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/i,
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class PromptPolicyPackageError extends Error {}

interface IntegrityFact {
  sha256: string;
  bytes: number;
}

interface FileFact extends IntegrityFact {
  path: string;
}

interface LegalFact extends IntegrityFact {
  sourcePath: string;
  packagedPath: string;
}

interface UpstreamFact extends IntegrityFact {
  repository: string;
  commit: string;
  path: string;
}

interface PromptManifestContract {
  upstream: UpstreamFact;
  patch: FileFact;
  output: FileFact;
  provenancePath: string;
  license: FileFact;
  notice: FileFact;
}

interface PromptPolicyContract {
  role: string;
  applied: FileFact;
  provenance: FileFact;
  developer: FileFact;
  compact: FileFact;
  upstream: UpstreamFact;
  license: LegalFact;
  notice: LegalFact;
}

export async function validatePromptPolicySource(
  sourceRoot: string,
): Promise<void> {
  await verifyCanonicalPromptLayer(sourceRoot);
  await validatePromptPolicyArtifacts(sourceRoot, sourceRoot, "source");
}

export async function validatePackagedPromptPolicy(
  sourceRoot: string,
  packageRoot: string,
): Promise<void> {
  await verifyCanonicalPromptLayer(sourceRoot);
  await validatePromptPolicyArtifacts(sourceRoot, packageRoot, "packaged");
  await validatePackagedPromptSurface(packageRoot);
}

export async function stagePromptPolicyPackage(
  sourceRoot: string,
  packageRoot: string,
): Promise<void> {
  await validatePromptPolicySource(sourceRoot);
  await assertNonSymlinkDirectory(packageRoot, "prompt-policy package root");

  for (const [sourcePath, destinationPath] of SOURCE_TO_PACKAGE_FILES) {
    await assertContainedRegularFile(sourceRoot, sourcePath, sourcePath);
    await prepareContainedDestination(packageRoot, destinationPath);
  }
  for (const [sourcePath, destinationPath] of SOURCE_TO_PACKAGE_FILES) {
    await copyFixedPolicyFile(
      sourceRoot,
      sourcePath,
      packageRoot,
      destinationPath,
    );
  }
}

async function verifyCanonicalPromptLayer(sourceRoot: string): Promise<void> {
  try {
    await checkPrompt(sourceRoot);
  } catch {
    throw new PromptPolicyPackageError(
      "Canonical prompt-layer verification failed.",
    );
  }
}

async function validatePackagedPromptSurface(
  packageRoot: string,
): Promise<void> {
  await assertExactFlatDirectory(
    packageRoot,
    "instructions",
    PACKAGED_INSTRUCTION_FILES,
    "packaged prompt instructions",
  );
  await assertExactFlatDirectory(
    packageRoot,
    "third_party/openai-codex",
    PACKAGED_OPENAI_LEGAL_FILES,
    "packaged OpenAI Codex legal directory",
  );
  await inspectPackagedTree(packageRoot);
}

async function assertExactFlatDirectory(
  packageRoot: string,
  relativePath: string,
  expectedNames: readonly string[],
  label: string,
): Promise<void> {
  await assertNonSymlinkDirectory(packageRoot, `${label} package root`);
  const directory = join(packageRoot, relativePath);
  await assertNonSymlinkDirectory(directory, label);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const metadata = await lstat(join(directory, entry.name));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new PromptPolicyPackageError(
        `${label} contains unexpected non-file entry ${entry.name}.`,
      );
    }
  }
  const actualNames = entries.map((entry) => entry.name);
  if (
    actualNames.length !== expectedNames.length ||
    expectedNames.some((name) => !actualNames.includes(name))
  ) {
    throw new PromptPolicyPackageError(
      `${label} must contain exactly ${expectedNames.join(", ")}.`,
    );
  }
}

async function inspectPackagedTree(packageRoot: string): Promise<void> {
  await assertNonSymlinkDirectory(packageRoot, "packaged plugin root");

  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      rejectMaintainerPromptArtifact(relativePath);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new PromptPolicyPackageError(
          `Packaged prompt surface contains symlink ${relativePath}.`,
        );
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (!metadata.isFile()) {
        throw new PromptPolicyPackageError(
          `Packaged prompt surface contains unsupported entry ${relativePath}.`,
        );
      }
    }
  }

  await visit(packageRoot);
}

function rejectMaintainerPromptArtifact(path: string): void {
  const framedPath = `/${path}`;
  if (
    framedPath.includes("/packages/core/prompt-layer/") ||
    framedPath.endsWith("/packages/core/prompt-layer") ||
    FORBIDDEN_PROMPT_TOOLING_SUFFIXES.some((suffix) =>
      framedPath.endsWith(`/${suffix}`),
    )
  ) {
    throw new PromptPolicyPackageError(
      `Packaged plugin contains maintainer-only prompt-layer artifact ${path}.`,
    );
  }
}

async function validatePromptPolicyArtifacts(
  sourceRoot: string,
  artifactRoot: string,
  mode: "source" | "packaged",
): Promise<void> {
  const manifest = await readPromptManifest(sourceRoot);
  const descriptorBytes = await readFixedPolicyFile(
    artifactRoot,
    PROMPT_POLICY_DESCRIPTOR,
    "prompt-policy descriptor",
  );
  validateCanonicalText(descriptorBytes, "prompt-policy descriptor");
  rejectMachinePath(descriptorBytes, "prompt-policy descriptor");
  const descriptor = parseJsonObject(
    descriptorBytes,
    "prompt-policy descriptor",
  );
  const policy = parsePromptPolicyContract(descriptor);
  assertPolicyMatchesManifest(policy, manifest);

  const appliedBytes = await readValidatedFact(
    artifactRoot,
    APPLIED_PROMPT,
    policy.applied,
    "applied prompt",
  );
  const provenanceBytes = await readValidatedFact(
    artifactRoot,
    PROMPT_PROVENANCE,
    policy.provenance,
    "prompt provenance",
  );
  const developerBytes = await readValidatedFact(
    artifactRoot,
    DEVELOPER_INSTRUCTIONS,
    policy.developer,
    "developer instructions",
  );
  const compactBytes = await readValidatedFact(
    artifactRoot,
    COMPACT_PROMPT,
    policy.compact,
    "compact prompt",
  );
  const licensePath = mode === "source" ? UPSTREAM_LICENSE : PACKAGED_LICENSE;
  const noticePath = mode === "source" ? UPSTREAM_NOTICE : PACKAGED_NOTICE;
  const licenseBytes = await readValidatedFact(
    artifactRoot,
    licensePath,
    policy.license,
    "OpenAI Codex LICENSE",
  );
  const noticeBytes = await readValidatedFact(
    artifactRoot,
    noticePath,
    policy.notice,
    "OpenAI Codex NOTICE",
  );

  for (const [bytes, label] of [
    [appliedBytes, "applied prompt"],
    [provenanceBytes, "prompt provenance"],
    [developerBytes, "developer instructions"],
    [compactBytes, "compact prompt"],
    [licenseBytes, "OpenAI Codex LICENSE"],
    [noticeBytes, "OpenAI Codex NOTICE"],
  ] as const) {
    validateCanonicalText(bytes, label);
    rejectMachinePath(bytes, label);
  }

  const provenance = parseJsonObject(provenanceBytes, "prompt provenance");
  validatePromptProvenance(provenance, policy, manifest);
}

async function readPromptManifest(
  sourceRoot: string,
): Promise<PromptManifestContract> {
  const bytes = await readFixedPolicyFile(
    sourceRoot,
    PROMPT_LAYER_MANIFEST,
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
    baseline.path !== UPSTREAM_BASELINE ||
    license.path !== UPSTREAM_LICENSE ||
    notice.path !== UPSTREAM_NOTICE ||
    patch.path !== PROMPT_PATCH ||
    output.path !== APPLIED_PROMPT ||
    provenancePath !== PROMPT_PROVENANCE
  ) {
    throw new PromptPolicyPackageError(
      "Prompt-layer manifest does not match the pinned packaging contract.",
    );
  }
  return { upstream, patch, output, provenancePath, license, notice };
}

function parsePromptPolicyContract(
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

function assertPolicyMatchesManifest(
  policy: PromptPolicyContract,
  manifest: PromptManifestContract,
): void {
  if (
    policy.role !== EXPECTED_BASELINE_ROLE ||
    policy.applied.path !== APPLIED_PROMPT ||
    policy.provenance.path !== PROMPT_PROVENANCE ||
    policy.developer.path !== DEVELOPER_INSTRUCTIONS ||
    policy.compact.path !== COMPACT_PROMPT ||
    !sameUpstream(policy.upstream, manifest.upstream) ||
    !sameIntegrity(policy.applied, manifest.output) ||
    policy.license.sourcePath !== UPSTREAM_LICENSE ||
    policy.license.packagedPath !== PACKAGED_LICENSE ||
    !sameIntegrity(policy.license, manifest.license) ||
    policy.notice.sourcePath !== UPSTREAM_NOTICE ||
    policy.notice.packagedPath !== PACKAGED_NOTICE ||
    !sameIntegrity(policy.notice, manifest.notice)
  ) {
    throw new PromptPolicyPackageError(
      "Prompt-policy descriptor does not match the pinned prompt-layer manifest.",
    );
  }
}

function validatePromptProvenance(
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
  if (
    typeof fact["sha256"] !== "string" ||
    !SHA256_PATTERN.test(fact["sha256"]) ||
    !Number.isSafeInteger(fact["bytes"]) ||
    (fact["bytes"] as number) <= 0
  ) {
    throw new PromptPolicyPackageError(`${label} has invalid integrity facts.`);
  }
  return {
    sha256: fact["sha256"],
    bytes: fact["bytes"] as number,
  };
}

async function readValidatedFact(
  root: string,
  fixedPath: string,
  fact: IntegrityFact,
  label: string,
): Promise<Buffer> {
  const bytes = await readFixedPolicyFile(root, fixedPath, label);
  assertDigest(bytes, fact, label);
  return bytes;
}

async function readFixedPolicyFile(
  root: string,
  fixedPath: string,
  label: string,
): Promise<Buffer> {
  await assertContainedRegularFile(root, fixedPath, label);
  return readFile(join(root, fixedPath));
}

async function assertContainedRegularFile(
  root: string,
  fixedPath: string,
  label: string,
): Promise<void> {
  await assertNonSymlinkDirectory(root, `${label} root`);
  let current = root;
  for (const segment of fixedPath.split("/")) {
    current = join(current, segment);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch {
      throw new PromptPolicyPackageError(
        `${label} is missing or inaccessible.`,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new PromptPolicyPackageError(
        `${label} uses a symlinked policy path.`,
      );
    }
  }
  const metadata = await lstat(current);
  if (!metadata.isFile()) {
    throw new PromptPolicyPackageError(
      `${label} must be a non-symlink regular file.`,
    );
  }
}

async function assertNonSymlinkDirectory(
  root: string,
  label: string,
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(root);
  } catch {
    throw new PromptPolicyPackageError(
      `${label} must be a non-symlink directory.`,
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PromptPolicyPackageError(
      `${label} must be a non-symlink directory.`,
    );
  }
}

async function prepareContainedDestination(
  root: string,
  fixedPath: string,
): Promise<void> {
  await assertNonSymlinkDirectory(root, "prompt-policy package root");
  let current = root;
  for (const segment of dirname(fixedPath).split("/")) {
    current = join(current, segment);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isMissing(error)) {
        throw new PromptPolicyPackageError(
          "Prompt-policy destination is inaccessible.",
        );
      }
      await mkdir(current);
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new PromptPolicyPackageError(
        "Prompt-policy destination uses an unsafe path.",
      );
    }
  }
  try {
    const target = await lstat(join(root, fixedPath));
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new PromptPolicyPackageError(
        "Prompt-policy destination uses an unsafe path.",
      );
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function copyFixedPolicyFile(
  sourceRoot: string,
  sourcePath: string,
  packageRoot: string,
  destinationPath: string,
): Promise<void> {
  const source = join(sourceRoot, sourcePath);
  const destination = join(packageRoot, destinationPath);
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PromptPolicyPackageError(
      `${sourcePath} must be a self-contained regular file.`,
    );
  }
  await copyFile(source, destination);
  await chmod(destination, metadata.mode & 0o777);
}

function parseJsonObject(
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

function assertDigest(bytes: Buffer, fact: IntegrityFact, label: string): void {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== fact.sha256 || bytes.byteLength !== fact.bytes) {
    throw new PromptPolicyPackageError(
      `${label} does not match the prompt-policy integrity facts.`,
    );
  }
}

function validateCanonicalText(bytes: Buffer, label: string): void {
  if (
    bytes.byteLength === 0 ||
    bytes.includes(0) ||
    bytes.at(-1) !== 0x0a ||
    bytes.includes(Buffer.from("\r"))
  ) {
    throw new PromptPolicyPackageError(`${label} must be canonical LF text.`);
  }
}

function rejectMachinePath(bytes: Buffer, label: string): void {
  const text = bytes.toString("utf8");
  if (MACHINE_PATH_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new PromptPolicyPackageError(
      `${label} contains a machine-specific path.`,
    );
  }
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

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
