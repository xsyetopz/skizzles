import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PROMPT_POLICY_DESCRIPTOR_PATHS } from "@skizzles/prompt-policy";
import { type JsonValue, readJsonFile } from "../codex-config.ts";
import { pathEntryExists } from "../managed-files.ts";

const MACHINE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/i,
];
const IMMUTABLE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface FileFact {
  path: string;
  sha256: string;
  bytes: number;
}

export interface LegalFact {
  sourcePath: string;
  packagedPath: string;
  sha256: string;
  bytes: number;
}

export interface UpstreamFact {
  repository: string;
  commit: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface PolicyFacts {
  descriptor: FileFact;
  role: string;
  applied: FileFact;
  provenance: FileFact;
  upstream: UpstreamFact;
  license: LegalFact;
  notice: LegalFact;
  developerInstructions: FileFact;
  compactPrompt: FileFact;
}

export interface PolicySource {
  facts: PolicyFacts;
  applied: Buffer;
  developerInstructions: string;
  compactPrompt: string;
}

export function readPolicySource(
  sourceRootInput: string,
  descriptorPathInput: string,
): PolicySource {
  if (!isAbsolute(sourceRootInput)) {
    throw new Error("--source-root must be an absolute path");
  }
  const requestedRoot = resolve(sourceRootInput);
  if (!existsSync(requestedRoot)) {
    throw new Error(`prompt-policy source root is missing: ${requestedRoot}`);
  }
  if (lstatSync(requestedRoot).isSymbolicLink()) {
    throw new Error(
      `prompt-policy source root may not use symlinked parents: ${requestedRoot}`,
    );
  }
  if (!lstatSync(requestedRoot).isDirectory()) {
    throw new Error(
      `prompt-policy source root is not a directory: ${requestedRoot}`,
    );
  }
  const sourceRoot = realpathSync(requestedRoot);
  const descriptorPath = portableRelativePath(
    descriptorPathInput,
    "prompt-policy descriptor path",
  );
  const packagedDescriptorPath = PROMPT_POLICY_DESCRIPTOR_PATHS.packagedPath;
  const descriptorSuffix = `/${packagedDescriptorPath}`;
  const sourcePrefix =
    descriptorPath === packagedDescriptorPath
      ? ""
      : descriptorPath.endsWith(descriptorSuffix)
        ? descriptorPath.slice(0, -descriptorSuffix.length)
        : undefined;
  if (sourcePrefix === undefined) {
    throw new Error(
      `prompt-policy descriptor path must end in ${packagedDescriptorPath}`,
    );
  }
  const descriptorAbsolute = resolveContainedFile(
    sourceRoot,
    descriptorPath,
    "prompt-policy descriptor",
  );
  const descriptorBytes = readFileSync(descriptorAbsolute);
  validateText(descriptorBytes, "prompt-policy descriptor");
  rejectMachinePaths(descriptorBytes, "prompt-policy descriptor");
  const descriptor = record(
    readJsonFile(descriptorAbsolute, "prompt-policy descriptor"),
    "prompt-policy descriptor",
  );
  exactKeys(
    descriptor,
    ["schema", "version", "base", "developerInstructions", "compactPrompt"],
    "prompt-policy descriptor",
  );
  if (
    descriptor["schema"] !== "skizzles.prompt-policy" ||
    descriptor["version"] !== 1
  ) {
    throw new Error("unsupported prompt-policy descriptor schema or version");
  }

  const base = record(descriptor["base"], "prompt-policy base");
  exactKeys(
    base,
    ["role", "applied", "provenance", "upstream", "legal"],
    "prompt-policy base",
  );
  const role = stringValue(base["role"], "prompt-policy base role");
  const applied = parseFileFact(base["applied"], "base applied prompt");
  const provenance = parseFileFact(base["provenance"], "base provenance");
  const upstream = parseUpstreamFact(base["upstream"]);
  const legal = record(base["legal"], "prompt-policy legal inputs");
  exactKeys(legal, ["license", "notice"], "prompt-policy legal inputs");
  const license = parseLegalFact(legal["license"], "prompt-policy LICENSE");
  const notice = parseLegalFact(legal["notice"], "prompt-policy NOTICE");
  assertCanonicalLegalMappings(license, notice);
  const developerInstructions = parseFileFact(
    descriptor["developerInstructions"],
    "developer instructions",
  );
  const compactPrompt = parseFileFact(
    descriptor["compactPrompt"],
    "compact prompt",
  );
  const facts: PolicyFacts = {
    descriptor: {
      path: descriptorPath,
      ...digest(descriptorBytes),
    },
    role,
    applied,
    provenance,
    upstream,
    license,
    notice,
    developerInstructions,
    compactPrompt,
  };

  const appliedBytes = readFactFile(
    sourceRoot,
    sourcePrefix,
    applied,
    "applied base prompt",
  );
  const provenanceBytes = readFactFile(
    sourceRoot,
    sourcePrefix,
    provenance,
    "base provenance",
  );
  const developerBytes = readFactFile(
    sourceRoot,
    sourcePrefix,
    developerInstructions,
    "developer instructions",
  );
  const compactBytes = readFactFile(
    sourceRoot,
    sourcePrefix,
    compactPrompt,
    "compact prompt",
  );
  readLegalFile(sourceRoot, license, "LICENSE");
  readLegalFile(sourceRoot, notice, "NOTICE");
  for (const [bytes, label] of [
    [appliedBytes, "applied base prompt"],
    [provenanceBytes, "base provenance"],
    [developerBytes, "developer instructions"],
    [compactBytes, "compact prompt"],
  ] as const) {
    validateText(bytes, label);
    rejectMachinePaths(bytes, label);
  }
  validateProvenance(provenanceBytes, facts);
  return {
    facts,
    applied: appliedBytes,
    developerInstructions: developerBytes.toString("utf8"),
    compactPrompt: compactBytes.toString("utf8"),
  };
}

export function parseFileFact(value: unknown, label: string): FileFact {
  const object = record(value, label);
  exactKeys(object, ["path", "sha256", "bytes"], label);
  const path = portableRelativePath(object["path"], `${label} path`);
  return {
    path,
    sha256: sha256Value(object["sha256"], `${label} sha256`),
    bytes: bytesValue(object["bytes"], `${label} bytes`),
  };
}

export function parseLegalFact(value: unknown, label: string): LegalFact {
  const object = record(value, label);
  exactKeys(object, ["sourcePath", "packagedPath", "sha256", "bytes"], label);
  return {
    sourcePath: portableRelativePath(
      object["sourcePath"],
      `${label} sourcePath`,
    ),
    packagedPath: portableRelativePath(
      object["packagedPath"],
      `${label} packagedPath`,
    ),
    sha256: sha256Value(object["sha256"], `${label} sha256`),
    bytes: bytesValue(object["bytes"], `${label} bytes`),
  };
}

export function assertCanonicalLegalMappings(
  license: LegalFact,
  notice: LegalFact,
): void {
  const canonicalSourceRoot = dirname(
    dirname(PROMPT_POLICY_DESCRIPTOR_PATHS.canonicalWorkspacePath),
  );
  if (
    license.sourcePath !== `${canonicalSourceRoot}/upstream/LICENSE` ||
    license.packagedPath !== "third_party/openai-codex/LICENSE" ||
    notice.sourcePath !== `${canonicalSourceRoot}/upstream/NOTICE` ||
    notice.packagedPath !== "third_party/openai-codex/NOTICE"
  ) {
    throw new Error(
      "prompt-policy legal paths must use the exact canonical LICENSE and NOTICE mappings",
    );
  }
}

export function parseUpstreamFact(value: unknown): UpstreamFact {
  const object = record(value, "prompt-policy upstream");
  exactKeys(
    object,
    ["repository", "commit", "path", "sha256", "bytes"],
    "prompt-policy upstream",
  );
  const repository = stringValue(object["repository"], "upstream repository");
  if (repository !== "https://github.com/openai/codex") {
    throw new Error(
      "prompt-policy upstream repository must be official OpenAI Codex",
    );
  }
  const commit = stringValue(object["commit"], "upstream commit");
  if (!IMMUTABLE_COMMIT_PATTERN.test(commit)) {
    throw new Error("upstream commit must be immutable lowercase SHA-1");
  }
  return {
    repository,
    commit,
    path: portableRelativePath(object["path"], "upstream path"),
    sha256: sha256Value(object["sha256"], "upstream sha256"),
    bytes: bytesValue(object["bytes"], "upstream bytes"),
  };
}

function readFactFile(
  root: string,
  sourcePrefix: string,
  fact: FileFact,
  label: string,
): Buffer {
  const path = sourcePrefix ? join(sourcePrefix, fact.path) : fact.path;
  const bytes = readFileSync(resolveContainedFile(root, path, label));
  assertDigest(bytes, fact, label);
  return bytes;
}

function readLegalFile(root: string, fact: LegalFact, label: string): Buffer {
  const candidates = [fact.sourcePath, fact.packagedPath].filter((path) =>
    existsSync(resolve(root, path)),
  );
  if (candidates.length === 0) {
    throw new Error(
      `${label} is missing from source and packaged policy paths`,
    );
  }
  let selected: Buffer | undefined;
  for (const path of candidates) {
    const bytes = readFileSync(resolveContainedFile(root, path, label));
    assertDigest(bytes, fact, label);
    selected ??= bytes;
  }
  if (!selected) {
    throw new Error(`${label} has no readable policy input`);
  }
  return selected;
}

function validateProvenance(bytes: Buffer, facts: PolicyFacts): void {
  const provenance = record(
    JSON.parse(bytes.toString("utf8")),
    "base provenance",
  );
  if (
    provenance["schema"] !== "skizzles.prompt-layer" ||
    provenance["version"] !== 1 ||
    provenance["baselineRole"] !== facts.role
  ) {
    throw new Error(
      "base provenance schema, version, or role does not match prompt-policy descriptor",
    );
  }
  const upstream = record(provenance["upstream"], "base provenance upstream");
  for (const key of [
    "repository",
    "commit",
    "path",
    "sha256",
    "bytes",
  ] as const) {
    if (upstream[key] !== facts.upstream[key]) {
      throw new Error(
        `base provenance upstream ${key} does not match prompt-policy descriptor`,
      );
    }
  }
  const output = record(provenance["output"], "base provenance output");
  if (
    output["sha256"] !== facts.applied.sha256 ||
    output["bytes"] !== facts.applied.bytes
  ) {
    throw new Error(
      "base provenance output does not match applied prompt descriptor",
    );
  }
  const legal = record(provenance["legal"], "base provenance legal");
  for (const [name, fact] of [
    ["license", facts.license],
    ["notice", facts.notice],
  ] as const) {
    const item = record(legal[name], `base provenance ${name}`);
    if (item["sha256"] !== fact.sha256 || item["bytes"] !== fact.bytes) {
      throw new Error(
        `base provenance ${name} does not match prompt-policy descriptor`,
      );
    }
  }
}
function resolveContainedFile(
  root: string,
  path: string,
  label: string,
): string {
  const portable = portableRelativePath(path, `${label} path`);
  const absolute = resolve(root, portable);
  const containment = relative(root, absolute);
  if (containment.startsWith("..") || isAbsolute(containment)) {
    throw new Error(`${label} escapes prompt-policy source root`);
  }
  let current = root;
  for (const segment of portable.split("/")) {
    current = join(current, segment);
    if (!pathEntryExists(current)) {
      throw new Error(`${label} is missing: ${portable}`);
    }
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} uses a symlink: ${portable}`);
    }
  }
  if (!lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute) {
    throw new Error(`${label} must be a contained regular file: ${portable}`);
  }
  return absolute;
}

function portableRelativePath(value: unknown, label: string): string {
  const path = stringValue(value, label);
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a normalized portable relative path`);
  }
  return path;
}

export function assertDigest(
  bytes: Buffer,
  fact: { sha256: string; bytes: number },
  label: string,
): void {
  const actual = digest(bytes);
  if (actual.sha256 !== fact.sha256 || actual.bytes !== fact.bytes) {
    throw new Error(
      `${label} digest or byte count does not match prompt-policy descriptor`,
    );
  }
}

function digest(bytes: Buffer): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function validateText(bytes: Buffer, label: string): void {
  if (
    bytes.length === 0 ||
    bytes.includes(0) ||
    bytes.at(-1) !== 0x0a ||
    bytes.includes(Buffer.from("\r"))
  ) {
    throw new Error(
      `${label} must be non-empty LF text with a final newline and no NUL`,
    );
  }
}

function rejectMachinePaths(bytes: Buffer, label: string): void {
  const text = bytes.toString("utf8");
  const match = MACHINE_PATH_PATTERNS.find((pattern) => pattern.test(text));
  if (match) {
    throw new Error(`${label} contains a machine-specific path`);
  }
}

export function exactKeys(
  object: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

export function jsonValue(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = jsonValue(item, `${label}.${key}`);
    }
    return result;
  }
  throw new Error(`${label} must be a JSON value`);
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function sha256Value(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!SHA256_PATTERN.test(text)) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
  return text;
}

export function bytesValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

export function publicFileFact(fact: FileFact): {
  sha256: string;
  bytes: number;
} {
  return { sha256: fact.sha256, bytes: fact.bytes };
}

export function publicLegalFact(fact: LegalFact): {
  sha256: string;
  bytes: number;
} {
  return { sha256: fact.sha256, bytes: fact.bytes };
}
