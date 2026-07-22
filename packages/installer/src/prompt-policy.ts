import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { PROMPT_POLICY_DESCRIPTOR_PATHS } from "@skizzles/prompt-layer";
import type { RunWorkspace } from "@skizzles/run-workspace";
import {
  type ConfigEdit,
  type ConfigRpc,
  canonicalExistingPath,
  isConfigVersionConflict,
  openConfigRpcSession,
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
} from "./prompt-policy/lock.ts";
import {
  cleanupNewPolicyFiles,
  cleanupOwnedPolicyFiles,
  createManagedTarget,
  type FileIdentity,
  fileIdentity,
  PROMPT_POLICY_KEYS,
  type PromptPolicyReceipt,
  readAndValidateReceipt,
  throwConfigDrift,
  validateManagedTarget,
  validateSourceMatchesReceipt,
} from "./prompt-policy/managed-state.ts";
import {
  type PolicySource,
  publicFileFact,
  publicLegalFact,
  readPolicySource,
} from "./prompt-policy/source.ts";

const RECEIPT_NAME = "prompt-policy-receipt.json";
const MANAGED_DIRECTORY = "prompt-policy";
const MANAGED_FILE = "skizzles-base.md";

export type { PromptPolicyReceipt } from "./prompt-policy/managed-state.ts";

export interface PromptPolicySourceDescriptor {
  readonly descriptorPath: string;
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
  sourceDescriptor?: PromptPolicySourceDescriptor;
  codexHome: string;
  codexBinary: string;
  dryRun?: boolean;
  rpcFactory?: (codexHome: string, codexBinary: string) => Promise<ConfigRpc>;
  workspace?: RunWorkspace;
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
  const source = readPolicySource(
    options.sourceRoot,
    options.sourceDescriptor?.descriptorPath ??
      descriptorPathForSourceRoot(options.sourceRoot),
  );
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
    workspace: options.workspace,
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
    if (options.dryRun) {
      return outcome;
    }

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
      await rpcSession.cleanup();
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
    workspace: options.workspace,
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const atBefore = valuesMatchBefore(layer.config, receipt.values);
    const atAfter = valuesMatchAfter(layer.config, receipt.values);
    if (!(atBefore || atAfter)) {
      throwConfigDrift(layer.config, receipt, "resume");
    }
    const outcome: PromptPolicyOutcome = {
      receipt,
      action: atAfter ? "activate-recovered" : "resume-apply",
      managedTargetClassification: "owned-managed-copy",
    };
    if (options.dryRun) {
      return outcome;
    }
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
      await rpcSession.cleanup();
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
  if (managedTargetExists) {
    validateManagedTarget(context, receipt);
  } else if (receipt.state !== "restoring") {
    throw new Error(
      "prompt-policy managed target is missing; retaining receipt evidence",
    );
  }

  const rpcSession = await openConfigRpcSession({
    codexHome: context.codexHome,
    codexBinary: context.codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
    workspace: options.workspace,
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
      if (!options.dryRun) {
        cleanupOwnedPolicyFiles(context, receipt);
      }
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
      if (!options.dryRun) {
        cleanupOwnedPolicyFiles(context, receipt);
      }
      return outcome;
    }
    if (!atAfter) {
      throwConfigDrift(layer.config, receipt, "restore");
    }

    const outcome: PromptPolicyOutcome = {
      receipt,
      action: "restore",
      managedTargetClassification: "owned-managed-copy",
    };
    if (options.dryRun) {
      return outcome;
    }

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
      await rpcSession.cleanup();
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
    { keyPath: PROMPT_POLICY_KEYS[0], value: target, mergeStrategy: "replace" },
    {
      keyPath: PROMPT_POLICY_KEYS[1],
      value: source.developerInstructions,
      mergeStrategy: "replace",
    },
    {
      keyPath: PROMPT_POLICY_KEYS[2],
      value: source.compactPrompt,
      mergeStrategy: "replace",
    },
  ];
}

function descriptorPathForSourceRoot(sourceRoot: string): string {
  const canonical = PROMPT_POLICY_DESCRIPTOR_PATHS.canonicalWorkspacePath;
  if (existsSync(resolve(sourceRoot, canonical))) {
    return canonical;
  }
  return PROMPT_POLICY_DESCRIPTOR_PATHS.packagedPath;
}
