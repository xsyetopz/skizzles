import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunWorkspace } from "@skizzles/run-workspace";
import {
  type ConfigEdit,
  type ConfigRpc,
  canonicalExistingPath,
  configValueAt,
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

export type { ConfigEdit, ConfigRpc } from "./codex-config.ts";
export type OrchestrationMode = "aggressive" | "passive";
export type InstructionMode = "native" | "skizzles";

export interface ConfigReceipt {
  version: 1;
  state: "pending" | "active" | "restoring";
  orchestration: OrchestrationMode;
  instructions?: InstructionMode;
  sourceRoot?: string;
  codexBinary: string;
  configPath: string;
  values: OwnedConfigValue[];
}

export interface ConfigureOptions {
  codexHome: string;
  codexBinary: string;
  orchestration: OrchestrationMode;
  instructions?: InstructionMode;
  sourceRoot?: string;
  dryRun?: boolean;
  rpcFactory?: (codexHome: string, codexBinary: string) => Promise<ConfigRpc>;
  workspace?: RunWorkspace;
}

const aggressiveModeHint =
  "Proactive complexity-aware delegation is active. Follow $fourth-wall whenever orchestration would materially improve speed or quality.";
const rootHint =
  "Fourth Wall applies. Read and follow $fourth-wall before this task's first orchestration action.";
const subagentHint =
  "Fourth Wall applies. Read and follow $fourth-wall and the behavioral role resource named in your assignment.";

const agentDescriptions = {
  default:
    "General Skizzles subagent with a compact developer-focused execution contract.",
  triage:
    "Focused read-only codebase research, diagnosis, and current-shape mapping.",
  worker:
    "Bounded implementation ownership through focused validation and evidence.",
  designer:
    "Frontend and product UI implementation with visual and accessibility proof.",
  qa: "Runtime piloting and evidence-rich product verification without silent fixes.",
  review:
    "Independent adversarial review, verification, and acceptance assessment.",
  deployment:
    "Authorized deployment and production-adjacent procedures with rollback discipline.",
} as const;
const agentRoles = [
  "default",
  "triage",
  "worker",
  "designer",
  "qa",
  "review",
  "deployment",
] as const;
type AgentRole = (typeof agentRoles)[number];

interface InstructionAssets {
  readonly sourceRoot: string;
  readonly rootInstructions: string;
  readonly agentConfigs: Readonly<Record<AgentRole, string>>;
}

function resolveInstructionAssets(sourceRootInput: string): InstructionAssets {
  const sourceRoot = canonicalExistingPath(sourceRootInput);
  const rootInstructions = join(
    sourceRoot,
    "assets",
    "skizzles_instructions.md",
  );
  const subagentInstructions = join(
    sourceRoot,
    "assets",
    "skizzles_subagent_instructions.md",
  );
  const agentConfigs: Record<AgentRole, string> = {
    default: join(sourceRoot, "assets", "agents/default.toml"),
    triage: join(sourceRoot, "assets", "agents/triage.toml"),
    worker: join(sourceRoot, "assets", "agents/worker.toml"),
    designer: join(sourceRoot, "assets", "agents/designer.toml"),
    qa: join(sourceRoot, "assets", "agents/qa.toml"),
    review: join(sourceRoot, "assets", "agents/review.toml"),
    deployment: join(sourceRoot, "assets", "agents/deployment.toml"),
  };
  const required = [
    rootInstructions,
    subagentInstructions,
    ...Object.values(agentConfigs),
  ];
  if (required.some((path) => !existsSync(path))) {
    throw new Error("Skizzles instruction assets are incomplete");
  }
  return Object.freeze({
    sourceRoot,
    rootInstructions,
    agentConfigs: Object.freeze(agentConfigs),
  });
}

export function configReceiptPath(codexHome: string): string {
  return join(
    canonicalExistingPath(codexHome),
    ".skizzles",
    "config-receipt.json",
  );
}

export function desiredConfigEdits(
  orchestration: OrchestrationMode,
  instructionAssets?: InstructionAssets,
  currentConfig: JsonValue = {},
): ConfigEdit[] {
  const edits: ConfigEdit[] = [
    { keyPath: "features.hooks", value: true, mergeStrategy: "replace" },
  ];
  if (instructionAssets !== undefined) {
    edits.push({
      keyPath: "model_instructions_file",
      value: instructionAssets.rootInstructions,
      mergeStrategy: "replace",
    });
    const configuredRoles: { [key: string]: JsonValue } = {};
    for (const role of agentRoles) {
      configuredRoles[role] = {
        description: agentDescriptions[role],
        config_file: instructionAssets.agentConfigs[role],
      };
    }
    const agents = configValueAt(currentConfig, "agents");
    if (!agents.present || !isJsonObject(agents.value)) {
      edits.push({
        keyPath: "agents",
        value: configuredRoles,
        mergeStrategy: "replace",
      });
    } else {
      for (const role of agentRoles) {
        const roleConfig: JsonValue = {
          description: agentDescriptions[role],
          config_file: instructionAssets.agentConfigs[role],
        };
        const existing = configValueAt(agents.value, role);
        if (!existing.present || !isJsonObject(existing.value)) {
          edits.push({
            keyPath: `agents.${role}`,
            value: roleConfig,
            mergeStrategy: "replace",
          });
        } else {
          edits.push(
            {
              keyPath: `agents.${role}.description`,
              value: agentDescriptions[role],
              mergeStrategy: "replace",
            },
            {
              keyPath: `agents.${role}.config_file`,
              value: instructionAssets.agentConfigs[role],
              mergeStrategy: "replace",
            },
          );
        }
      }
    }
  }
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

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readReceipt(codexHome: string): ConfigReceipt {
  const path = configReceiptPath(codexHome);
  if (!existsSync(path)) {
    throw new Error(`Skizzles config receipt is missing: ${path}`);
  }
  const parsed = readJsonFile(path, "Skizzles config receipt");
  const receipt = objectValue(parsed);
  if (
    receipt?.["version"] !== 1 ||
    !isReceiptState(receipt["state"]) ||
    !isOrchestrationMode(receipt["orchestration"]) ||
    typeof receipt["codexBinary"] !== "string" ||
    typeof receipt["configPath"] !== "string" ||
    !Array.isArray(receipt["values"])
  ) {
    throw new Error(`invalid Skizzles config receipt: ${path}`);
  }
  const values = receipt["values"].map((value) => {
    const owned = objectValue(value);
    if (
      typeof owned?.["keyPath"] !== "string" ||
      typeof owned["beforePresent"] !== "boolean" ||
      !isJsonValue(owned["before"]) ||
      !isJsonValue(owned["after"])
    ) {
      throw new Error(`invalid Skizzles config receipt: ${path}`);
    }
    return {
      keyPath: owned["keyPath"],
      beforePresent: owned["beforePresent"],
      before: owned["before"],
      after: owned["after"],
    };
  });
  const instructions = receipt["instructions"];
  if (instructions !== undefined && !isInstructionMode(instructions)) {
    throw new Error(`invalid Skizzles config receipt: ${path}`);
  }
  const sourceRoot = receipt["sourceRoot"];
  if (sourceRoot !== undefined && typeof sourceRoot !== "string") {
    throw new Error(`invalid Skizzles config receipt: ${path}`);
  }
  return {
    version: 1,
    state: receipt["state"],
    orchestration: receipt["orchestration"],
    ...(instructions === undefined ? {} : { instructions }),
    ...(sourceRoot === undefined ? {} : { sourceRoot }),
    codexBinary: receipt["codexBinary"],
    configPath: receipt["configPath"],
    values,
  };
}

function isReceiptState(value: unknown): value is ConfigReceipt["state"] {
  return value === "pending" || value === "active" || value === "restoring";
}

function isOrchestrationMode(value: unknown): value is OrchestrationMode {
  return value === "aggressive" || value === "passive";
}

function isInstructionMode(value: unknown): value is InstructionMode {
  return value === "native" || value === "skizzles";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  const object = objectValue(value);
  return object !== undefined && Object.values(object).every(isJsonValue);
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
  if (!pathEntryExists(receiptPath)) {
    return;
  }
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
  if (dryRun) {
    return receipt;
  }
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
  const instructions = options.instructions ?? "native";
  if (instructions === "native" && options.sourceRoot !== undefined) {
    throw new Error("--source-root requires --instructions skizzles");
  }
  let instructionAssets: InstructionAssets | undefined;
  if (instructions === "skizzles") {
    const sourceRoot = options.sourceRoot;
    if (sourceRoot === undefined) {
      throw new Error("--source-root is required with --instructions skizzles");
    }
    instructionAssets = resolveInstructionAssets(sourceRoot);
  }
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
    workspace: options.workspace,
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

    const edits = desiredConfigEdits(
      options.orchestration,
      instructionAssets,
      layer.config,
    );
    const receipt: ConfigReceipt = {
      version: 1,
      state: "pending",
      orchestration: options.orchestration,
      instructions,
      ...(instructionAssets === undefined
        ? {}
        : { sourceRoot: instructionAssets.sourceRoot }),
      codexBinary,
      configPath,
      values: snapshotConfigValues(layer.config, edits),
    };
    if (options.dryRun) {
      return receipt;
    }

    writePrivateJson(receiptPath, receipt, true);
    await writeConfigBatch(rpc, edits, configPath, layer.version, receiptPath);
    receipt.state = "active";
    writePrivateJson(receiptPath, receipt);
    return receipt;
  } finally {
    try {
      await rpc.close();
    } finally {
      await rpcSession.cleanup();
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
    workspace: options.workspace,
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
      if (!options.dryRun) {
        rmSync(receiptPath);
      }
      return receipt;
    }
    if (!atAfter) {
      throw new Error("refusing to restore drifted config keys");
    }
    if (options.dryRun) {
      return receipt;
    }

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
      await rpcSession.cleanup();
    }
  }
}
