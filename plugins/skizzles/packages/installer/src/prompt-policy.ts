import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type ConfigEdit,
  type ConfigRpc,
  canonicalExistingPath,
  isConfigVersionConflict,
  type JsonValue,
  type OwnedConfigValue,
  openConfigRpcSession,
  readJsonFile,
  restoreConfigEdits,
  safeConfigWriteError,
  selectedUserLayer,
  snapshotConfigValues,
  validateCodexBinary,
  valuesMatchAfter,
  valuesMatchBefore,
  writePrivateJson,
} from "./codex-config.ts";
import {
  assertManagedParentsAreReal,
  pathEntryExists,
} from "./managed-files.ts";
import {
  type PromptPolicyLockOptions,
  withPromptPolicyLock,
} from "./prompt-policy-lock.ts";

const RECEIPT_NAME = "prompt-policy-receipt.json";
const MANAGED_DIRECTORY = "prompt-policy";
const MANAGED_FILE = "skizzles-base.md";
const DESCRIPTOR_PATH = "integrations/prompt-policy.json";
const POLICY_KEYS = [
  "model_instructions_file",
  "developer_instructions",
  "compact_prompt",
] as const;
const MACHINE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/i,
];
const IMMUTABLE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface FileFact {
  path: string;
  sha256: string;
  bytes: number;
}

interface LegalFact {
  sourcePath: string;
  packagedPath: string;
  sha256: string;
  bytes: number;
}

interface UpstreamFact {
  repository: string;
  commit: string;
  path: string;
  sha256: string;
  bytes: number;
}

interface PolicyFacts {
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

interface PolicySource {
  facts: PolicyFacts;
  applied: Buffer;
  developerInstructions: string;
  compactPrompt: string;
}

interface FileIdentity {
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

export interface PromptPolicyOutcome {
  receipt: PromptPolicyReceipt;
  action:
    | "apply"
    | "resume-apply"
    | "activate-recovered"
    | "restore"
    | "finish-restore"
    | "discard-pending";
  managedTargetClassification: "new-managed-copy" | "owned-managed-copy";
}

interface CommonOptions {
  codexHome: string;
  codexBinary: string;
  dryRun?: boolean;
  rpcFactory?: (codexHome: string, codexBinary: string) => Promise<ConfigRpc>;
  lockOptions?: PromptPolicyLockOptions;
  /** Test-only crash injection after a successful atomic config write. */
  afterBatchWrite?: () => void;
  /** Test-only concurrency barrier after pending evidence is durable. */
  afterPendingReceipt?: () => void | Promise<void>;
}

export interface ApplyPromptPolicyOptions extends CommonOptions {
  sourceRoot: string;
}

export type RestorePromptPolicyOptions = CommonOptions;

export function promptPolicyReceiptPath(codexHome: string): string {
  return join(canonicalExistingPath(codexHome), ".skizzles", RECEIPT_NAME);
}

export function promptPolicyManagedPath(codexHome: string): string {
  return join(
    canonicalExistingPath(codexHome),
    ".skizzles",
    MANAGED_DIRECTORY,
    MANAGED_FILE,
  );
}

export function applyPromptPolicy(
  options: ApplyPromptPolicyOptions,
): Promise<PromptPolicyOutcome> {
  return withPromptPolicyLock(
    canonicalExistingPath(options.codexHome),
    "apply",
    options.lockOptions,
    () => applyPromptPolicyUnlocked(options),
  );
}

async function applyPromptPolicyUnlocked(
  options: ApplyPromptPolicyOptions,
): Promise<PromptPolicyOutcome> {
  const context = validateContext(options);
  const source = readPolicySource(options.sourceRoot);
  const receiptExists = pathEntryExists(context.receiptPath);
  const targetExists = pathEntryExists(context.managedTarget);

  if (receiptExists !== targetExists) {
    throw new Error(
      "prompt-policy receipt/managed-target ownership is incomplete; refusing mutation",
    );
  }

  if (receiptExists) {
    const receipt = readAndValidateReceipt(context);
    validateManagedTarget(context, receipt);
    validateSourceMatchesReceipt(source, receipt);
    if (receipt.state === "active") {
      throw new Error("prompt policy is already active");
    }
    if (receipt.state === "restoring") {
      throw new Error(
        "prompt policy restoration is pending; run prompt-policy restore",
      );
    }
    return resumeApply(options, context, receipt);
  }

  const rpcSession = await openConfigRpcSession({
    codexHome: context.codexHome,
    codexBinary: context.codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const edits = policyEdits(context.managedTarget, source);
    const receipt: PromptPolicyReceipt = {
      schema: "skizzles.prompt-policy-receipt",
      version: 1,
      state: "pending",
      codexBinary: context.codexBinary,
      configPath: context.configPath,
      managedTarget: {
        path: context.managedTarget,
        sha256: source.facts.applied.sha256,
        bytes: source.facts.applied.bytes,
      },
      policy: source.facts,
      values: snapshotConfigValues(layer.config, edits),
    };
    const outcome: PromptPolicyOutcome = {
      receipt,
      action: "apply",
      managedTargetClassification: "new-managed-copy",
    };
    if (options.dryRun) return outcome;

    const managedIdentity = createManagedTarget(context, source.applied);
    let receiptIdentity: FileIdentity;
    try {
      writePrivateJson(context.receiptPath, receipt, true);
      receiptIdentity = fileIdentity(context.receiptPath);
    } catch (error) {
      cleanupNewPolicyFiles(context, managedIdentity);
      throw error;
    }
    await options.afterPendingReceipt?.();
    try {
      await rpc.batchWrite({
        edits,
        filePath: context.configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true,
      });
    } catch (error) {
      if (isConfigVersionConflict(error)) {
        cleanupNewPolicyFiles(context, managedIdentity, receiptIdentity);
      }
      throw safeConfigWriteError(error);
    }
    options.afterBatchWrite?.();
    receipt.state = "active";
    writePrivateJson(context.receiptPath, receipt);
    return outcome;
  } finally {
    try {
      await rpc.close();
    } finally {
      rpcSession.cleanup();
    }
  }
}

async function resumeApply(
  options: ApplyPromptPolicyOptions,
  context: PolicyContext,
  receipt: PromptPolicyReceipt,
): Promise<PromptPolicyOutcome> {
  const rpcSession = await openConfigRpcSession({
    codexHome: context.codexHome,
    codexBinary: context.codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const atBefore = valuesMatchBefore(layer.config, receipt.values);
    const atAfter = valuesMatchAfter(layer.config, receipt.values);
    if (!(atBefore || atAfter))
      throwConfigDrift(layer.config, receipt, "resume");
    const outcome: PromptPolicyOutcome = {
      receipt,
      action: atAfter ? "activate-recovered" : "resume-apply",
      managedTargetClassification: "owned-managed-copy",
    };
    if (options.dryRun) return outcome;
    if (atBefore) {
      try {
        await rpc.batchWrite({
          edits: receipt.values.map(({ keyPath, after }) => ({
            keyPath,
            value: after,
            mergeStrategy: "replace",
          })),
          filePath: context.configPath,
          expectedVersion: layer.version,
          reloadUserConfig: true,
        });
      } catch (error) {
        throw safeConfigWriteError(error);
      }
      options.afterBatchWrite?.();
    }
    receipt.state = "active";
    writePrivateJson(context.receiptPath, receipt);
    return outcome;
  } finally {
    try {
      await rpc.close();
    } finally {
      rpcSession.cleanup();
    }
  }
}

export function restorePromptPolicy(
  options: RestorePromptPolicyOptions,
): Promise<PromptPolicyOutcome> {
  return withPromptPolicyLock(
    canonicalExistingPath(options.codexHome),
    "restore",
    options.lockOptions,
    () => restorePromptPolicyUnlocked(options),
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: State-machine branches are kept together so every preflight precedes mutation.
async function restorePromptPolicyUnlocked(
  options: RestorePromptPolicyOptions,
): Promise<PromptPolicyOutcome> {
  const context = validateContext(options);
  if (!pathEntryExists(context.receiptPath)) {
    throw new Error(
      `Skizzles prompt-policy receipt is missing: ${context.receiptPath}`,
    );
  }
  const receipt = readAndValidateReceipt(context);
  const managedTargetExists = pathEntryExists(context.managedTarget);
  if (managedTargetExists) validateManagedTarget(context, receipt);
  else if (receipt.state !== "restoring") {
    throw new Error(
      "prompt-policy managed target is missing; retaining receipt evidence",
    );
  }

  const rpcSession = await openConfigRpcSession({
    codexHome: context.codexHome,
    codexBinary: context.codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const atBefore = valuesMatchBefore(layer.config, receipt.values);
    const atAfter = valuesMatchAfter(layer.config, receipt.values);

    if (receipt.state === "restoring" && atBefore) {
      const outcome: PromptPolicyOutcome = {
        receipt,
        action: "finish-restore",
        managedTargetClassification: "owned-managed-copy",
      };
      if (!options.dryRun) cleanupOwnedPolicyFiles(context, receipt);
      return outcome;
    }
    if (!managedTargetExists) {
      throw new Error(
        "prompt-policy managed target disappeared before restoration completed; retaining receipt evidence",
      );
    }
    if (receipt.state === "pending" && atBefore) {
      const outcome: PromptPolicyOutcome = {
        receipt,
        action: "discard-pending",
        managedTargetClassification: "owned-managed-copy",
      };
      if (!options.dryRun) cleanupOwnedPolicyFiles(context, receipt);
      return outcome;
    }
    if (!atAfter) throwConfigDrift(layer.config, receipt, "restore");

    const outcome: PromptPolicyOutcome = {
      receipt,
      action: "restore",
      managedTargetClassification: "owned-managed-copy",
    };
    if (options.dryRun) return outcome;

    receipt.state = "restoring";
    writePrivateJson(context.receiptPath, receipt);
    try {
      await rpc.batchWrite({
        edits: restoreConfigEdits(receipt.values),
        filePath: context.configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true,
      });
    } catch (error) {
      throw safeConfigWriteError(error);
    }
    options.afterBatchWrite?.();
    cleanupOwnedPolicyFiles(context, receipt);
    return outcome;
  } finally {
    try {
      await rpc.close();
    } finally {
      rpcSession.cleanup();
    }
  }
}

export function promptPolicySummary(
  outcome: PromptPolicyOutcome,
  dryRun: boolean,
): Record<string, unknown> {
  const { receipt } = outcome;
  return {
    ok: true,
    dryRun,
    surface: "prompt-policy",
    action: outcome.action,
    state: receipt.state,
    configPath: receipt.configPath,
    keys: receipt.values.map(({ keyPath, beforePresent }) => ({
      keyPath,
      beforePresent,
    })),
    policy: {
      descriptor: publicFileFact(receipt.policy.descriptor),
      applied: publicFileFact(receipt.policy.applied),
      developerInstructions: publicFileFact(
        receipt.policy.developerInstructions,
      ),
      compactPrompt: publicFileFact(receipt.policy.compactPrompt),
      license: publicLegalFact(receipt.policy.license),
      notice: publicLegalFact(receipt.policy.notice),
    },
    managedTarget: {
      path: receipt.managedTarget.path,
      classification: outcome.managedTargetClassification,
      sha256: receipt.managedTarget.sha256,
      bytes: receipt.managedTarget.bytes,
    },
    sessionImpact: "new Codex sessions required",
    compactPromptScope:
      "local compaction only; remote compaction may bypass it",
  };
}

interface PolicyContext {
  codexHome: string;
  codexBinary: string;
  configPath: string;
  receiptPath: string;
  managedDirectory: string;
  managedTarget: string;
}

function validateContext(options: CommonOptions): PolicyContext {
  if (!isAbsolute(options.codexHome)) {
    throw new Error("--codex-home must be an absolute path");
  }
  const codexHome = canonicalExistingPath(options.codexHome);
  if (!(existsSync(codexHome) && lstatSync(codexHome).isDirectory())) {
    throw new Error(`CODEX_HOME is missing or not a directory: ${codexHome}`);
  }
  if (lstatSync(resolve(options.codexHome)).isSymbolicLink()) {
    throw new Error(`CODEX_HOME may not be a symlink: ${options.codexHome}`);
  }
  assertManagedParentsAreReal(codexHome, [
    ".skizzles",
    `.skizzles/${MANAGED_DIRECTORY}`,
  ]);
  const codexBinary = validateCodexBinary(options.codexBinary);
  return {
    codexHome,
    codexBinary,
    configPath: join(codexHome, "config.toml"),
    receiptPath: join(codexHome, ".skizzles", RECEIPT_NAME),
    managedDirectory: join(codexHome, ".skizzles", MANAGED_DIRECTORY),
    managedTarget: join(
      codexHome,
      ".skizzles",
      MANAGED_DIRECTORY,
      MANAGED_FILE,
    ),
  };
}

function policyEdits(target: string, source: PolicySource): ConfigEdit[] {
  return [
    { keyPath: POLICY_KEYS[0], value: target, mergeStrategy: "replace" },
    {
      keyPath: POLICY_KEYS[1],
      value: source.developerInstructions,
      mergeStrategy: "replace",
    },
    {
      keyPath: POLICY_KEYS[2],
      value: source.compactPrompt,
      mergeStrategy: "replace",
    },
  ];
}

function readPolicySource(sourceRootInput: string): PolicySource {
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
  const descriptorAbsolute = resolveContainedFile(
    sourceRoot,
    DESCRIPTOR_PATH,
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
      path: DESCRIPTOR_PATH,
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

  const appliedBytes = readFactFile(sourceRoot, applied, "applied base prompt");
  const provenanceBytes = readFactFile(
    sourceRoot,
    provenance,
    "base provenance",
  );
  const developerBytes = readFactFile(
    sourceRoot,
    developerInstructions,
    "developer instructions",
  );
  const compactBytes = readFactFile(
    sourceRoot,
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

function parseFileFact(value: unknown, label: string): FileFact {
  const object = record(value, label);
  exactKeys(object, ["path", "sha256", "bytes"], label);
  const path = portableRelativePath(object["path"], `${label} path`);
  return {
    path,
    sha256: sha256Value(object["sha256"], `${label} sha256`),
    bytes: bytesValue(object["bytes"], `${label} bytes`),
  };
}

function parseLegalFact(value: unknown, label: string): LegalFact {
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

function assertCanonicalLegalMappings(
  license: LegalFact,
  notice: LegalFact,
): void {
  if (
    license.sourcePath !== "packages/core/prompt-layer/upstream/LICENSE" ||
    license.packagedPath !== "third_party/openai-codex/LICENSE" ||
    notice.sourcePath !== "packages/core/prompt-layer/upstream/NOTICE" ||
    notice.packagedPath !== "third_party/openai-codex/NOTICE"
  ) {
    throw new Error(
      "prompt-policy legal paths must use the exact canonical LICENSE and NOTICE mappings",
    );
  }
}

function parseUpstreamFact(value: unknown): UpstreamFact {
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
  if (!IMMUTABLE_COMMIT_PATTERN.test(commit))
    throw new Error("upstream commit must be immutable lowercase SHA-1");
  return {
    repository,
    commit,
    path: portableRelativePath(object["path"], "upstream path"),
    sha256: sha256Value(object["sha256"], "upstream sha256"),
    bytes: bytesValue(object["bytes"], "upstream bytes"),
  };
}

function readFactFile(root: string, fact: FileFact, label: string): Buffer {
  const bytes = readFileSync(resolveContainedFile(root, fact.path, label));
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
  if (!selected) throw new Error(`${label} has no readable policy input`);
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

function createManagedTarget(
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
    if (createdTarget)
      removeOwnedIdentity(context.managedTarget, createdTarget);
    if (createdDirectory) removeDirectoryIfEmpty(context.managedDirectory);
    throw error;
  }
}

function readAndValidateReceipt(context: PolicyContext): PromptPolicyReceipt {
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
    value["version"] !== 1 ||
    !["pending", "active", "restoring"].includes(String(value["state"]))
  ) {
    throw new Error("invalid prompt-policy receipt schema, version, or state");
  }
  const receipt = value as unknown as PromptPolicyReceipt;
  if (
    !isAbsolute(receipt.codexBinary) ||
    resolve(receipt.codexBinary) !== context.codexBinary
  ) {
    throw new Error(
      `use the Codex binary recorded by the prompt-policy receipt: ${receipt.codexBinary}`,
    );
  }
  if (
    !isAbsolute(receipt.configPath) ||
    resolve(receipt.configPath) !== context.configPath
  ) {
    throw new Error(
      "prompt-policy receipt config path is outside selected CODEX_HOME",
    );
  }
  const targetObject = record(receipt.managedTarget, "receipt managed target");
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
  receipt.managedTarget = target;
  receipt.policy = validateReceiptPolicy(receipt.policy);
  validateReceiptValues(receipt);
  return receipt;
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

function validateReceiptValues(receipt: PromptPolicyReceipt): void {
  if (
    !Array.isArray(receipt.values) ||
    receipt.values.length !== POLICY_KEYS.length
  ) {
    throw new Error(
      "prompt-policy receipt must own exactly three config values",
    );
  }
  for (const [index, expectedKey] of POLICY_KEYS.entries()) {
    const value = record(receipt.values[index], `receipt value ${expectedKey}`);
    exactKeys(
      value,
      ["keyPath", "beforePresent", "before", "after"],
      `receipt value ${expectedKey}`,
    );
    if (
      value["keyPath"] !== expectedKey ||
      typeof value["beforePresent"] !== "boolean"
    ) {
      throw new Error(
        `prompt-policy receipt has invalid owned key ${expectedKey}`,
      );
    }
  }
  if (receipt.values[0]?.after !== receipt.managedTarget.path) {
    throw new Error(
      "prompt-policy receipt model instructions target is swapped",
    );
  }
  for (const [index, fact, label] of [
    [1, receipt.policy.developerInstructions, "developer instructions"],
    [2, receipt.policy.compactPrompt, "compact prompt"],
  ] as const) {
    const after = receipt.values[index]?.after;
    if (typeof after !== "string")
      throw new Error(`receipt ${label} is not a string`);
    assertDigest(Buffer.from(after), fact, `receipt ${label}`);
  }
  if (
    receipt.managedTarget.sha256 !== receipt.policy.applied.sha256 ||
    receipt.managedTarget.bytes !== receipt.policy.applied.bytes
  ) {
    throw new Error(
      "receipt managed target fact does not match applied prompt fact",
    );
  }
}

function validateManagedTarget(
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

function validateSourceMatchesReceipt(
  source: PolicySource,
  receipt: PromptPolicyReceipt,
): void {
  if (JSON.stringify(source.facts) !== JSON.stringify(receipt.policy)) {
    throw new Error(
      "selected prompt-policy source does not match the pending receipt",
    );
  }
}

function cleanupNewPolicyFiles(
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
  if (receiptPresent) rmSync(context.receiptPath);
  if (managedPresent) rmSync(context.managedTarget);
  removeDirectoryIfEmpty(context.managedDirectory);
}

function cleanupOwnedPolicyFiles(
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
  if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
}

function fileIdentity(path: string): FileIdentity {
  const metadata = lstatSync(path);
  return { dev: metadata.dev, ino: metadata.ino };
}

function removeOwnedIdentity(path: string, expected: FileIdentity): void {
  if (!assertOwnedIdentity(path, expected)) return;
  rmSync(path);
}

function assertOwnedIdentity(path: string, expected: FileIdentity): boolean {
  if (!pathEntryExists(path)) return false;
  const actual = fileIdentity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(
      `refusing to clean replaced prompt-policy owned file: ${path}`,
    );
  }
  return true;
}

function throwConfigDrift(
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
  const keys = drifted.length > 0 ? drifted : POLICY_KEYS;
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
    current = current[segment] as JsonValue;
  }
  return { present: true, value: current };
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    if (!pathEntryExists(current))
      throw new Error(`${label} is missing: ${portable}`);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink())
      throw new Error(`${label} uses a symlink: ${portable}`);
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

function assertDigest(
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
  if (match) throw new Error(`${label} contains a machine-specific path`);
}

function assertRegularPrivateFile(path: string, label: string): void {
  if (!pathEntryExists(path)) throw new Error(`${label} is missing: ${path}`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw new Error(`${label} must be a non-symlink regular file`);
  if ((metadata.mode & 0o777) !== 0o600)
    throw new Error(`${label} must have owner-only mode 0600`);
}

function assertPrivateDirectory(path: string, label: string): void {
  if (!pathEntryExists(path)) throw new Error(`${label} is missing: ${path}`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`${label} must be a non-symlink directory`);
  if ((metadata.mode & 0o777) !== 0o700)
    throw new Error(`${label} must have owner-only mode 0700`);
}

function exactKeys(
  object: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0"))
    throw new Error(`${label} has unexpected or missing fields`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function sha256Value(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!SHA256_PATTERN.test(text))
    throw new Error(`${label} must be lowercase SHA-256`);
  return text;
}

function bytesValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function publicFileFact(fact: FileFact): { sha256: string; bytes: number } {
  return { sha256: fact.sha256, bytes: fact.bytes };
}

function publicLegalFact(fact: LegalFact): { sha256: string; bytes: number } {
  return { sha256: fact.sha256, bytes: fact.bytes };
}
