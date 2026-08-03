import { join, resolve } from "node:path";
import {
  assertManagedParentsAreReal,
  canonicalExistingPath,
  pathEntryExists,
} from "../managed-filesystem";
import {
  CodexAppServerAdapter,
  resolveCodexBinary,
  selectUserConfigLayer,
  type ConfigRpc,
} from "./codex-app-server";
import { assertSupportedCodexBinary } from "./codex-version";
import {
  desiredConfigEdits,
  resolveInstructionAssets,
  sameJsonValue,
  valueAt,
  type JsonValue,
  type InstructionMode,
  type OrchestrationMode,
} from "./edit-policy";
import {
  activateConfigReceipt,
  beginConfigRestoration,
  configReceiptPath,
  readConfigReceipt,
  readPendingConfigReconciliation,
  removeConfigReceipt,
  removePendingConfigReconciliation,
  writePendingConfigReceipt,
  type ConfigReconcileChange,
  type ConfigReceipt,
} from "./receipt";
import { isReceiptOwnedTable, migrateLegacyAgentOwnership } from "./reconciliation";

export { ensureCodexConfigured, reconcileCodex } from "./reconciliation";

export interface ConfigureOptions {
  codexHome: string;
  codexBinary: string;
  orchestration: OrchestrationMode;
  instructions?: InstructionMode;
  sourceRoot?: string;
  dryRun?: boolean;
  rpcFactory?: (codexHome: string, codexBinary: string) => Promise<ConfigRpc>;
}

export interface UnconfigureOptions {
  codexHome: string;
  codexBinary: string;
  dryRun?: boolean;
  rpcFactory?: (codexHome: string, codexBinary: string) => Promise<ConfigRpc>;
}

export type ConfigApplyStatus = "install" | "reconcile" | "noop";

export interface EnsureConfigResult {
  receipt: ConfigReceipt;
  status: ConfigApplyStatus;
}

export async function configureCodex(options: ConfigureOptions): Promise<ConfigReceipt> {
  const codexHome = canonicalExistingPath(options.codexHome);
  const codexBinary = resolveCodexBinary(options.codexBinary);
  await assertSupportedCodexBinary(codexBinary);
  const instructions = options.instructions ?? "native";
  if (instructions === "skizzles" && !options.sourceRoot) {
    throw new Error("--source-root is required with --instructions skizzles");
  }
  const instructionAssets = instructions === "skizzles"
    ? resolveInstructionAssets(options.sourceRoot!)
    : undefined;
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  if (pathEntryExists(receiptPath)) throw new Error(`Skizzles config receipt already exists: ${receiptPath}`);

  const configPath = join(codexHome, "config.toml");
  const rpc = await (options.rpcFactory ?? CodexAppServerAdapter.create)(codexHome, codexBinary);
  try {
    const layer = selectUserConfigLayer(await rpc.read(), configPath);
    const edits = desiredConfigEdits(options.orchestration, instructionAssets, layer.config);
    const values = edits.map(({ keyPath, value }) => {
      const before = valueAt(layer.config, keyPath);
      return { keyPath, beforePresent: before.present, before: before.value, after: value };
    });
    let receipt: ConfigReceipt = {
      version: 1,
      state: "pending",
      orchestration: options.orchestration,
      instructions,
      ...(instructionAssets ? { sourceRoot: instructionAssets.sourceRoot } : {}),
      codexBinary,
      configPath,
      values,
      ...(instructionAssets && !valueAt(layer.config, "agents").present
        ? { cleanupPaths: ["agents", ...roleCleanupPaths(edits)] }
        : {}),
    };
    if (options.dryRun) return receipt;

    writePendingConfigReceipt(receiptPath, receipt);
    try {
      await rpc.batchWrite({
        edits,
        filePath: configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true,
      });
    } catch (error) {
      // A version conflict proves that Codex rejected the write.  Transport
      // failures do not: the server may have applied the batch before the
      // response was lost.  Keep the pending receipt in that case so
      // `unconfigure` can compare the before/after values and recover either
      // outcome safely.
      if (isVersionConflict(error)) removeConfigReceipt(receiptPath, true);
      throw error;
    }
    receipt = activateConfigReceipt(receiptPath, receipt);
    return receipt;
  } finally {
    await rpc.close();
  }
}

export async function unconfigureCodex(options: UnconfigureOptions): Promise<ConfigReceipt> {
  const codexHome = canonicalExistingPath(options.codexHome);
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  const pendingTransactionRaw = readPendingConfigReconciliation(codexHome);
  const pendingTransaction = pendingTransactionRaw
    ? {
      ...pendingTransactionRaw,
      previous: migrateLegacyAgentOwnership(pendingTransactionRaw.previous),
      next: migrateLegacyAgentOwnership(pendingTransactionRaw.next),
    }
    : undefined;
  let storedReceipt: ConfigReceipt | undefined;
  try {
    storedReceipt = migrateLegacyAgentOwnership(readConfigReceipt(codexHome));
  } catch (error) {
    if (!pendingTransaction) throw error;
  }
  if (storedReceipt?.state === "pending" && pendingTransaction) {
    throw new Error("Skizzles config has both a pending install receipt and a pending reconciliation marker");
  }
  let receipt = storedReceipt ?? pendingTransaction?.previous;
  if (!receipt) throw new Error(`Skizzles config receipt is missing: ${receiptPath}`);
  const codexBinary = resolveCodexBinary(options.codexBinary);
  if (resolve(receipt.codexBinary) !== codexBinary) {
    throw new Error(`use the Codex binary recorded by the config receipt: ${receipt.codexBinary}`);
  }
  if (resolve(receipt.configPath) !== join(codexHome, "config.toml")) {
    throw new Error("config receipt points outside the selected CODEX_HOME");
  }

  const rpc = await (options.rpcFactory ?? CodexAppServerAdapter.create)(codexHome, codexBinary);
  try {
    const layer = selectUserConfigLayer(await rpc.read(), receipt.configPath);
    if (storedReceipt?.state === "pending") {
      // A fresh configure has no active receipt to pair with a reconciliation
      // marker.  Its pending receipt is the transaction: compare the current
      // config against both snapshots before deciding whether the batch was
      // rejected, committed, or genuinely ambiguous.
      const before = receiptValuesMatch(layer.config, receipt, false);
      const after = receiptValuesMatch(layer.config, receipt, true);
      if (before && after) {
        // Every desired value was already equal to its baseline.  No write
        // outcome can have changed the config, so discard the marker safely.
        if (!options.dryRun) removeConfigReceipt(receiptPath, true);
        return receipt;
      }
      if (before) {
        if (!options.dryRun) removeConfigReceipt(receiptPath, true);
        return receipt;
      }
      if (!after) {
        throw new Error("pending Skizzles config install has an ambiguous commit state; inspect and resolve it before restoring");
      }
    } else if (pendingTransaction && storedReceipt?.state !== "restoring") {
      const before = pendingTransaction.changes.every((change) => changeMatches(layer.config, change, false));
      const after = pendingTransaction.changes.every((change) => changeMatches(layer.config, change, true));
      if (before === after) {
        throw new Error("pending Skizzles config reconciliation has an ambiguous commit state; inspect and resolve it before restoring");
      }
      if (before) {
        if (!options.dryRun) removePendingConfigReconciliation(codexHome, true);
        receipt = pendingTransaction.previous;
      } else {
        receipt = pendingTransaction.next;
      }
    } else if (storedReceipt?.state === "restoring") {
      // A restore batch may have committed before the process failed while
      // removing the receipt/transaction marker.  The restoring receipt is
      // the authoritative baseline for the retry; do not reinterpret the
      // original reconcile transaction as an install commit.
      receipt = storedReceipt;
    }
    const atBefore = receipt.values.every(({ keyPath, beforePresent, before }) => {
      const current = valueAt(layer.config, keyPath);
      return current.present === beforePresent && (!beforePresent || sameJsonValue(current.value, before));
    });
    if (receipt.state === "restoring" && atBefore) {
      if (!options.dryRun) {
        removeConfigReceipt(receiptPath);
        if (pendingTransaction) removePendingConfigReconciliation(codexHome, true);
      }
      return receipt;
    }
    for (const value of receipt.values) {
      const current = valueAt(layer.config, value.keyPath);
      if (!current.present || !sameJsonValue(current.value, value.after)) {
        throw new Error(`refusing to restore drifted config key: ${value.keyPath}`);
      }
    }
    if (options.dryRun) return receipt;

    receipt = beginConfigRestoration(receiptPath, receipt);
    const restoreEdits = receipt.values.map(({ keyPath, beforePresent, before }) => ({
      keyPath,
      value: beforePresent ? before : null,
      mergeStrategy: "replace" as const,
    }));
    for (const cleanupPath of [...(receipt.cleanupPaths ?? [])].sort((left, right) => right.split(".").length - left.split(".").length)) {
      const current = valueAt(layer.config, cleanupPath);
      if (current.present && isReceiptOwnedTable(current.value, cleanupPath, receipt.values)) {
        restoreEdits.push({ keyPath: cleanupPath, value: null, mergeStrategy: "replace" });
      }
    }
    await rpc.batchWrite({
      edits: restoreEdits,
      filePath: receipt.configPath,
      expectedVersion: layer.version,
      reloadUserConfig: true,
    });
    removeConfigReceipt(receiptPath);
    if (pendingTransaction) removePendingConfigReconciliation(codexHome, true);
    return receipt;
  } finally {
    await rpc.close();
  }
}

function changeMatches(
  config: JsonValue,
  change: ConfigReconcileChange,
  after: boolean,
): boolean {
  const current = valueAt(config, change.keyPath);
  const expectedPresent = after ? change.afterPresent : change.beforePresent;
  const expectedValue = after ? change.after : change.before;
  return current.present === expectedPresent && (!expectedPresent || sameJsonValue(current.value, expectedValue));
}

function receiptValuesMatch(
  config: JsonValue,
  receipt: ConfigReceipt,
  after: boolean,
): boolean {
  return receipt.values.every(({ keyPath, beforePresent, before, after: expectedAfter }) => {
    const current = valueAt(config, keyPath);
    if (after) return current.present && sameJsonValue(current.value, expectedAfter);
    return current.present === beforePresent && (!beforePresent || sameJsonValue(current.value, before));
  });
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && /config.?version.?conflict|version.?conflict/i.test(error.message);
}

function roleCleanupPaths(edits: Array<{ keyPath: string }>): string[] {
  return [...new Set(
    edits
      .filter(({ keyPath }) => keyPath.startsWith("agents."))
      .map(({ keyPath }) => keyPath.split(".").slice(0, 2).join(".")),
  )];
}
