import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  type JsonValue,
  type OwnedConfigValue,
  readJsonFile,
} from "../codex-config.ts";
import { pathEntryExists } from "../managed-files.ts";
import {
  assertCanonicalLegalMappings,
  assertDigest,
  bytesValue,
  exactKeys,
  type FileFact,
  jsonValue,
  type PolicyFacts,
  type PolicySource,
  parseFileFact,
  parseLegalFact,
  parseUpstreamFact,
  record,
  sha256Value,
  stringValue,
} from "./source.ts";

export const PROMPT_POLICY_KEYS = [
  "model_instructions_file",
  "developer_instructions",
  "compact_prompt",
] as const;

export interface PolicyContext {
  codexHome: string;
  codexBinary: string;
  configPath: string;
  receiptPath: string;
  managedDirectory: string;
  managedTarget: string;
}

export interface FileIdentity {
  dev: number;
  ino: number;
}

export interface PromptPolicyReceipt {
  schema: "skizzles.prompt-policy-receipt";
  version: 1;
  state: "pending" | "active" | "restoring";
  codexBinary: string;
  configPath: string;
  managedTarget: FileFact;
  policy: PolicyFacts;
  values: OwnedConfigValue[];
}

export function createManagedTarget(
  context: PolicyContext,
  bytes: Buffer,
): FileIdentity {
  const skizzlesDirectory = dirname(context.managedDirectory);
  mkdirSync(skizzlesDirectory, { recursive: true, mode: 0o700 });
  chmodSync(skizzlesDirectory, 0o700);
  let createdDirectory = false;
  let createdTarget: FileIdentity | undefined;
  try {
    mkdirSync(context.managedDirectory, { mode: 0o700 });
    createdDirectory = true;
    chmodSync(context.managedDirectory, 0o700);
    writeFileSync(context.managedTarget, bytes, { flag: "wx", mode: 0o600 });
    createdTarget = fileIdentity(context.managedTarget);
    chmodSync(context.managedTarget, 0o600);
    return createdTarget;
  } catch (error) {
    if (createdTarget) {
      removeOwnedIdentity(context.managedTarget, createdTarget);
    }
    if (createdDirectory) {
      removeDirectoryIfEmpty(context.managedDirectory);
    }
    throw error;
  }
}

export function readAndValidateReceipt(
  context: PolicyContext,
): PromptPolicyReceipt {
  assertPrivateDirectory(dirname(context.receiptPath), ".skizzles directory");
  if (pathEntryExists(context.managedDirectory)) {
    assertPrivateDirectory(
      context.managedDirectory,
      "prompt-policy managed directory",
    );
  }
  assertRegularPrivateFile(context.receiptPath, "prompt-policy receipt");
  const value = record(
    readJsonFile(context.receiptPath, "Skizzles prompt-policy receipt"),
    "prompt-policy receipt",
  );
  exactKeys(
    value,
    [
      "schema",
      "version",
      "state",
      "codexBinary",
      "configPath",
      "managedTarget",
      "policy",
      "values",
    ],
    "prompt-policy receipt",
  );
  if (
    value["schema"] !== "skizzles.prompt-policy-receipt" ||
    value["version"] !== 1
  ) {
    throw new Error("invalid prompt-policy receipt schema, version, or state");
  }
  const state = receiptState(value["state"]);
  const codexBinary = stringValue(value["codexBinary"], "receipt Codex binary");
  if (
    !isAbsolute(codexBinary) ||
    resolve(codexBinary) !== context.codexBinary
  ) {
    throw new Error(
      `use the Codex binary recorded by the prompt-policy receipt: ${codexBinary}`,
    );
  }
  const configPath = stringValue(value["configPath"], "receipt config path");
  if (!isAbsolute(configPath) || resolve(configPath) !== context.configPath) {
    throw new Error(
      "prompt-policy receipt config path is outside selected CODEX_HOME",
    );
  }
  const targetObject = record(value["managedTarget"], "receipt managed target");
  exactKeys(
    targetObject,
    ["path", "sha256", "bytes"],
    "receipt managed target",
  );
  const target: FileFact = {
    path: stringValue(targetObject["path"], "receipt managed target path"),
    sha256: sha256Value(
      targetObject["sha256"],
      "receipt managed target sha256",
    ),
    bytes: bytesValue(targetObject["bytes"], "receipt managed target bytes"),
  };
  if (
    !isAbsolute(target.path) ||
    resolve(target.path) !== context.managedTarget
  ) {
    throw new Error(
      "prompt-policy receipt managed target is escaped or swapped",
    );
  }
  const policy = validateReceiptPolicy(value["policy"]);
  const values = parseReceiptValues(value["values"], target, policy);
  const receipt: PromptPolicyReceipt = {
    schema: "skizzles.prompt-policy-receipt",
    version: 1,
    state,
    codexBinary,
    configPath,
    managedTarget: target,
    policy,
    values,
  };
  return receipt;
}

function receiptState(value: unknown): PromptPolicyReceipt["state"] {
  if (value === "pending" || value === "active" || value === "restoring") {
    return value;
  }
  throw new Error("invalid prompt-policy receipt schema, version, or state");
}

function validateReceiptPolicy(value: unknown): PolicyFacts {
  const object = record(value, "receipt policy facts");
  exactKeys(
    object,
    [
      "descriptor",
      "role",
      "applied",
      "provenance",
      "upstream",
      "license",
      "notice",
      "developerInstructions",
      "compactPrompt",
    ],
    "receipt policy facts",
  );
  const policy: PolicyFacts = {
    descriptor: parseFileFact(object["descriptor"], "receipt descriptor"),
    role: stringValue(object["role"], "receipt policy role"),
    applied: parseFileFact(object["applied"], "receipt applied prompt"),
    provenance: parseFileFact(object["provenance"], "receipt provenance"),
    upstream: parseUpstreamFact(object["upstream"]),
    license: parseLegalFact(object["license"], "receipt LICENSE"),
    notice: parseLegalFact(object["notice"], "receipt NOTICE"),
    developerInstructions: parseFileFact(
      object["developerInstructions"],
      "receipt developer instructions",
    ),
    compactPrompt: parseFileFact(
      object["compactPrompt"],
      "receipt compact prompt",
    ),
  };
  assertCanonicalLegalMappings(policy.license, policy.notice);
  return policy;
}

function parseReceiptValues(
  value: unknown,
  managedTarget: FileFact,
  policy: PolicyFacts,
): OwnedConfigValue[] {
  if (!Array.isArray(value) || value.length !== PROMPT_POLICY_KEYS.length) {
    throw new Error(
      "prompt-policy receipt must own exactly three config values",
    );
  }
  const values: OwnedConfigValue[] = [];
  for (const [index, expectedKey] of PROMPT_POLICY_KEYS.entries()) {
    const owned = record(value[index], `receipt value ${expectedKey}`);
    exactKeys(
      owned,
      ["keyPath", "beforePresent", "before", "after"],
      `receipt value ${expectedKey}`,
    );
    if (
      owned["keyPath"] !== expectedKey ||
      typeof owned["beforePresent"] !== "boolean"
    ) {
      throw new Error(
        `prompt-policy receipt has invalid owned key ${expectedKey}`,
      );
    }
    values.push({
      keyPath: expectedKey,
      beforePresent: owned["beforePresent"],
      before: jsonValue(owned["before"], `receipt ${expectedKey} before`),
      after: jsonValue(owned["after"], `receipt ${expectedKey} after`),
    });
  }
  const modelInstructionsAfter = values[0]?.after;
  if (typeof modelInstructionsAfter !== "string") {
    throw new Error("receipt model instructions target must be a string");
  }
  if (modelInstructionsAfter !== managedTarget.path) {
    throw new Error(
      "prompt-policy receipt model instructions target is swapped",
    );
  }
  for (const [index, fact, label] of [
    [1, policy.developerInstructions, "developer instructions"],
    [2, policy.compactPrompt, "compact prompt"],
  ] as const) {
    const after = values[index]?.after;
    if (typeof after !== "string") {
      throw new Error(`receipt ${label} is not a string`);
    }
    assertDigest(Buffer.from(after), fact, `receipt ${label}`);
  }
  if (
    managedTarget.sha256 !== policy.applied.sha256 ||
    managedTarget.bytes !== policy.applied.bytes
  ) {
    throw new Error(
      "receipt managed target fact does not match applied prompt fact",
    );
  }
  return values;
}

export function validateManagedTarget(
  context: PolicyContext,
  receipt: PromptPolicyReceipt,
): void {
  assertPrivateDirectory(
    dirname(context.managedDirectory),
    ".skizzles directory",
  );
  assertPrivateDirectory(
    context.managedDirectory,
    "prompt-policy managed directory",
  );
  assertRegularPrivateFile(
    context.managedTarget,
    "prompt-policy managed target",
  );
  const bytes = readFileSync(context.managedTarget);
  assertDigest(bytes, receipt.managedTarget, "prompt-policy managed target");
}

export function validateSourceMatchesReceipt(
  source: PolicySource,
  receipt: PromptPolicyReceipt,
): void {
  if (JSON.stringify(source.facts) !== JSON.stringify(receipt.policy)) {
    throw new Error(
      "selected prompt-policy source does not match the pending receipt",
    );
  }
}

export function cleanupNewPolicyFiles(
  context: PolicyContext,
  managedIdentity: FileIdentity,
  receiptIdentity?: FileIdentity,
): void {
  const receiptPresent = receiptIdentity
    ? assertOwnedIdentity(context.receiptPath, receiptIdentity)
    : false;
  const managedPresent = assertOwnedIdentity(
    context.managedTarget,
    managedIdentity,
  );
  if (receiptPresent) {
    rmSync(context.receiptPath);
  }
  if (managedPresent) {
    rmSync(context.managedTarget);
  }
  removeDirectoryIfEmpty(context.managedDirectory);
}

export function cleanupOwnedPolicyFiles(
  context: PolicyContext,
  receipt: PromptPolicyReceipt,
): void {
  if (pathEntryExists(context.managedTarget)) {
    validateManagedTarget(context, receipt);
    rmSync(context.managedTarget);
  }
  removeDirectoryIfEmpty(context.managedDirectory);
  rmSync(context.receiptPath, { force: true });
}

function removeDirectoryIfEmpty(path: string): void {
  if (existsSync(path) && readdirSync(path).length === 0) {
    rmdirSync(path);
  }
}

export function fileIdentity(path: string): FileIdentity {
  const metadata = lstatSync(path);
  return { dev: metadata.dev, ino: metadata.ino };
}

function removeOwnedIdentity(path: string, expected: FileIdentity): void {
  if (!assertOwnedIdentity(path, expected)) {
    return;
  }
  rmSync(path);
}

function assertOwnedIdentity(path: string, expected: FileIdentity): boolean {
  if (!pathEntryExists(path)) {
    return false;
  }
  const actual = fileIdentity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(
      `refusing to clean replaced prompt-policy owned file: ${path}`,
    );
  }
  return true;
}

export function throwConfigDrift(
  config: JsonValue,
  receipt: PromptPolicyReceipt,
  operation: string,
): never {
  const drifted = receipt.values
    .filter((value) => {
      const current = configValue(config, value.keyPath);
      const before =
        current.present === value.beforePresent &&
        (!value.beforePresent || sameJson(current.value, value.before));
      const after = current.present && sameJson(current.value, value.after);
      return !(before || after);
    })
    .map(({ keyPath }) => keyPath);
  const keys = drifted.length > 0 ? drifted : PROMPT_POLICY_KEYS;
  throw new Error(
    `refusing to ${operation} drifted prompt-policy config keys: ${keys.join(", ")}`,
  );
}

function configValue(
  root: JsonValue,
  keyPath: string,
): { present: boolean; value: JsonValue } {
  let current = root;
  for (const segment of keyPath.split(".")) {
    if (
      current === null ||
      Array.isArray(current) ||
      typeof current !== "object" ||
      !(segment in current)
    ) {
      return { present: false, value: null };
    }
    const next = current[segment];
    if (next === undefined) {
      return { present: false, value: null };
    }
    current = next;
  }
  return { present: true, value: current };
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRegularPrivateFile(path: string, label: string): void {
  if (!pathEntryExists(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must have owner-only mode 0600`);
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  if (!pathEntryExists(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must have owner-only mode 0700`);
  }
}
