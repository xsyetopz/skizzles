import { resolve } from "node:path";
import {
  ensureCodexConfigured,
  configReceiptPath,
  type ConfigRpc,
  type ConfigApplyStatus,
  type InstructionMode,
  type OrchestrationMode,
} from "./config";
import {
  ensureHarness,
  harnessReceiptPath,
  inspectHarness,
  type HarnessApplyStatus,
  type HarnessInspection,
  type HarnessReceipt,
} from "./harness";
import type { Transfer } from "./managed-filesystem";

export interface LocalSuiteOptions {
  sourceRoot: string;
  home: string;
  codexHome: string;
  codexBinary: string;
  transfer: Transfer;
  orchestration: OrchestrationMode;
  instructions: InstructionMode;
  dryRun?: boolean;
  rpcFactory?: (codexHome: string, codexBinary: string) => Promise<ConfigRpc>;
}

export interface LocalSuiteResult {
  ok: true;
  dryRun: boolean;
  surface: "local-suite";
  sourceRoot: string;
  home: string;
  codexHome: string;
  transfer: Transfer;
  orchestration: OrchestrationMode;
  instructions: InstructionMode;
  harness: {
    status: HarnessApplyStatus;
    pluginTarget: string;
    marketplacePath: string;
    receiptPath: string;
  };
  config: {
    status: ConfigApplyStatus;
    configPath: string;
    receiptPath: string;
    keys: string[];
  };
  recovery?: string;
}

/**
 * Install or reconcile the complete checkout-local suite.
 *
 * Harness inspection is deliberately performed before any write.  Config is
 * applied first so a failed harness transfer leaves an explicit receipt and a
 * safe `unconfigure` recovery path rather than a blind rollback over edits
 * that may have raced another process.
 */
export async function installLocalSuite(options: LocalSuiteOptions): Promise<LocalSuiteResult> {
  const sourceRoot = resolve(options.sourceRoot);
  const home = resolve(options.home);
  const codexHome = resolve(options.codexHome);
  const dryRun = options.dryRun === true;
  const harnessInspection = inspectHarness({
    sourceRoot,
    home,
    transfer: options.transfer,
    dryRun,
  });
  if (harnessInspection.status === "foreign-conflict" || harnessInspection.status === "drift-conflict") {
    throw new Error(`harness ${harnessInspection.status}: ${harnessInspection.reason ?? "target is not receipt-owned"}`);
  }

  const config = await ensureCodexConfigured({
    codexHome,
    codexBinary: options.codexBinary,
    orchestration: options.orchestration,
    instructions: options.instructions,
    sourceRoot,
    dryRun,
    ...(options.rpcFactory ? { rpcFactory: options.rpcFactory } : {}),
  });

  let harness: { receipt: HarnessReceipt; status: HarnessApplyStatus };
  try {
    // In dry-run mode this creates only an in-memory receipt.  In apply mode
    // installHarness runs last, after config has committed successfully.
    harness = ensureHarness({ sourceRoot, home, transfer: options.transfer, dryRun });
  } catch (error) {
    if (config.status !== "noop" && !dryRun) {
      const reason = error instanceof Error ? error.message : "harness installation failed";
      throw new Error(
        `local suite partially completed: configuration ${config.status} succeeded; ${reason}. ` +
        `Review the receipt and run unconfigure before retrying`,
      );
    }
    throw error;
  }

  return {
    ok: true,
    dryRun,
    surface: "local-suite",
    sourceRoot,
    home,
    codexHome,
    transfer: options.transfer,
    orchestration: options.orchestration,
    instructions: options.instructions,
    harness: {
      status: harness.status,
      pluginTarget: harness.receipt.pluginTarget,
      marketplacePath: harness.receipt.marketplacePath,
      receiptPath: harnessReceiptPath(home),
    },
    config: {
      status: config.status,
      configPath: config.receipt.configPath,
      receiptPath: configReceiptPath(codexHome),
      keys: config.receipt.values.map(({ keyPath }) => keyPath),
    },
    ...(config.status !== "noop" && !dryRun && harness.status === "noop"
      ? { recovery: "Configuration changed; use unconfigure with the receipt binary to restore it." }
      : {}),
  };
}

export type { HarnessInspection };
