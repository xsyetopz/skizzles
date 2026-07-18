import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ConfigEdit,
  type ConfigRpc,
  canonicalExistingPath,
  isConfigVersionConflict,
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
import { assertManagedParentsAreReal, pathEntryExists } from "./core.ts";

export type { ConfigEdit, ConfigRpc } from "./codex-config.ts";
export type OrchestrationMode = "aggressive" | "passive";

export interface ConfigReceipt {
  version: 1;
  state: "pending" | "active" | "restoring";
  orchestration: OrchestrationMode;
  codexBinary: string;
  configPath: string;
  values: OwnedConfigValue[];
}

export interface ConfigureOptions {
  codexHome: string;
  codexBinary: string;
  orchestration: OrchestrationMode;
  dryRun?: boolean;
  rpcFactory?: (codexHome: string, codexBinary: string) => Promise<ConfigRpc>;
}

const aggressiveModeHint =
  "Proactive complexity-aware delegation is active. Follow $fourth-wall whenever orchestration would materially improve speed or quality.";
const rootHint =
  "Fourth Wall applies. Read and follow $fourth-wall before this task's first orchestration action.";
const subagentHint =
  "Fourth Wall applies. Read and follow $fourth-wall and the behavioral role resource named in your assignment.";

export function configReceiptPath(codexHome: string): string {
  return join(
    canonicalExistingPath(codexHome),
    ".skizzles",
    "config-receipt.json",
  );
}

export function desiredConfigEdits(
  orchestration: OrchestrationMode,
): ConfigEdit[] {
  const edits: ConfigEdit[] = [
    { keyPath: "features.hooks", value: true, mergeStrategy: "replace" },
  ];
  if (orchestration === "aggressive") {
    edits.push(
      {
        keyPath: "features.multi_agent_v2.enabled",
        value: true,
        mergeStrategy: "replace",
      },
      {
        keyPath: "features.multi_agent_v2.max_concurrent_threads_per_session",
        value: 7,
        mergeStrategy: "replace",
      },
      {
        keyPath: "features.multi_agent_v2.multi_agent_mode_hint_text",
        value: aggressiveModeHint,
        mergeStrategy: "replace",
      },
      {
        keyPath: "features.multi_agent_v2.root_agent_usage_hint_text",
        value: rootHint,
        mergeStrategy: "replace",
      },
      {
        keyPath: "features.multi_agent_v2.subagent_usage_hint_text",
        value: subagentHint,
        mergeStrategy: "replace",
      },
    );
  }
  return edits;
}

function readReceipt(codexHome: string): ConfigReceipt {
  const path = configReceiptPath(codexHome);
  if (!existsSync(path)) {
    throw new Error(`Skizzles config receipt is missing: ${path}`);
  }
  const receipt = readJsonFile(
    path,
    "Skizzles config receipt",
  ) as Partial<ConfigReceipt>;
  if (
    receipt.version !== 1 ||
    !["pending", "active", "restoring"].includes(receipt.state ?? "") ||
    !["aggressive", "passive"].includes(receipt.orchestration ?? "") ||
    typeof receipt.codexBinary !== "string" ||
    typeof receipt.configPath !== "string" ||
    !Array.isArray(receipt.values)
  ) {
    throw new Error(`invalid Skizzles config receipt: ${path}`);
  }
  return receipt as ConfigReceipt;
}

function validateReceiptTarget(
  receipt: ConfigReceipt,
  codexHome: string,
  codexBinary: string,
): void {
  if (resolve(receipt.codexBinary) !== codexBinary) {
    throw new Error(
      `use the Codex binary recorded by the config receipt: ${receipt.codexBinary}`,
    );
  }
  if (resolve(receipt.configPath) !== join(codexHome, "config.toml")) {
    throw new Error("config receipt points outside the selected CODEX_HOME");
  }
}

function receiptConfigEdits(receipt: ConfigReceipt): ConfigEdit[] {
  return receipt.values.map(({ keyPath, after }) => ({
    keyPath,
    value: after,
    mergeStrategy: "replace",
  }));
}

function pendingConfigureReceipt(
  receiptPath: string,
  codexHome: string,
  codexBinary: string,
  orchestration: OrchestrationMode,
): ConfigReceipt | undefined {
  if (!pathEntryExists(receiptPath)) return undefined;
  const receipt = readReceipt(codexHome);
  validateReceiptTarget(receipt, codexHome, codexBinary);
  if (receipt.state === "active") {
    throw new Error(`Skizzles config receipt already exists: ${receiptPath}`);
  }
  if (receipt.state === "restoring") {
    throw new Error(
      "Skizzles config restoration is pending; run unconfigure before configuring again",
    );
  }
  if (receipt.orchestration !== orchestration) {
    throw new Error(
      "pending config recovery uses a different orchestration mode; use the recorded mode or run unconfigure",
    );
  }
  return receipt;
}

async function writeConfigBatch(
  rpc: ConfigRpc,
  edits: ConfigEdit[],
  filePath: string,
  expectedVersion: string,
  conflictReceiptPath?: string,
): Promise<void> {
  try {
    await rpc.batchWrite({
      edits,
      filePath,
      expectedVersion,
      reloadUserConfig: true,
    });
  } catch (error) {
    if (conflictReceiptPath && isConfigVersionConflict(error)) {
      rmSync(conflictReceiptPath, { force: true });
    }
    throw safeConfigWriteError(error);
  }
}

async function recoverPendingConfigure(
  receipt: ConfigReceipt,
  receiptPath: string,
  config: Parameters<typeof valuesMatchAfter>[0],
  expectedVersion: string,
  rpc: ConfigRpc,
  dryRun?: boolean,
): Promise<ConfigReceipt> {
  const atAfter = valuesMatchAfter(config, receipt.values);
  const atBefore = valuesMatchBefore(config, receipt.values);
  if (!(atAfter || atBefore)) {
    throw new Error(
      "refusing to recover pending configuration after owned keys drifted",
    );
  }
  if (dryRun) return receipt;
  if (!atAfter) {
    await writeConfigBatch(
      rpc,
      receiptConfigEdits(receipt),
      receipt.configPath,
      expectedVersion,
    );
  }
  receipt.state = "active";
  writePrivateJson(receiptPath, receipt);
  return receipt;
}

export async function configureCodex(
  options: ConfigureOptions,
): Promise<ConfigReceipt> {
  const codexHome = canonicalExistingPath(options.codexHome);
  const codexBinary = validateCodexBinary(options.codexBinary);
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  const existingReceipt = pendingConfigureReceipt(
    receiptPath,
    codexHome,
    codexBinary,
    options.orchestration,
  );

  const configPath = join(codexHome, "config.toml");
  const rpcSession = await openConfigRpcSession({
    codexHome,
    codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    if (existingReceipt) {
      return recoverPendingConfigure(
        existingReceipt,
        receiptPath,
        layer.config,
        layer.version,
        rpc,
        options.dryRun,
      );
    }

    const edits = desiredConfigEdits(options.orchestration);
    const receipt: ConfigReceipt = {
      version: 1,
      state: "pending",
      orchestration: options.orchestration,
      codexBinary,
      configPath,
      values: snapshotConfigValues(layer.config, edits),
    };
    if (options.dryRun) return receipt;

    writePrivateJson(receiptPath, receipt, true);
    await writeConfigBatch(rpc, edits, configPath, layer.version, receiptPath);
    receipt.state = "active";
    writePrivateJson(receiptPath, receipt);
    return receipt;
  } finally {
    try {
      await rpc.close();
    } finally {
      rpcSession.cleanup();
    }
  }
}

export async function unconfigureCodex(
  options: Omit<ConfigureOptions, "orchestration">,
): Promise<ConfigReceipt> {
  const codexHome = canonicalExistingPath(options.codexHome);
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  const receipt = readReceipt(codexHome);
  const codexBinary = validateCodexBinary(options.codexBinary);
  validateReceiptTarget(receipt, codexHome, codexBinary);

  const rpcSession = await openConfigRpcSession({
    codexHome,
    codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const atBefore = valuesMatchBefore(layer.config, receipt.values);
    const atAfter = valuesMatchAfter(layer.config, receipt.values);
    if (
      atBefore &&
      (receipt.state === "pending" || receipt.state === "restoring")
    ) {
      if (!options.dryRun) rmSync(receiptPath);
      return receipt;
    }
    if (!atAfter) {
      throw new Error("refusing to restore drifted config keys");
    }
    if (options.dryRun) return receipt;

    receipt.state = "restoring";
    writePrivateJson(receiptPath, receipt);
    try {
      await rpc.batchWrite({
        edits: restoreConfigEdits(receipt.values),
        filePath: receipt.configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true,
      });
    } catch (error) {
      throw safeConfigWriteError(error);
    }
    rmSync(receiptPath);
    return receipt;
  } finally {
    try {
      await rpc.close();
    } finally {
      rpcSession.cleanup();
    }
  }
}
