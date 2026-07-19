import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { RunWorkspace } from "@skizzles/run-workspace";
import { cleanupStale, create } from "@skizzles/run-workspace";
import {
  createConfigPreviewSnapshot,
  PreviewConfigRpc,
} from "./codex-config/preview.ts";
import { AppServerRpc } from "./codex-config/rpc.ts";
import type {
  ConfigRpc,
  ConfigRpcSession,
} from "./codex-config/rpc-contract.ts";
import { canonicalExistingPath } from "./codex-config/values.ts";

export {
  ensurePrivateDirectory,
  readJsonFile,
  writePrivateJson,
} from "./codex-config/private-files.ts";
export type { ConfigRpcErrorKind } from "./codex-config/rpc.ts";
export {
  AppServerRpc,
  ConfigRpcError,
  isConfigVersionConflict,
  safeConfigWriteError,
} from "./codex-config/rpc.ts";
export type {
  ConfigEdit,
  ConfigLayer,
  ConfigReadResponse,
  ConfigRpc,
  ConfigRpcSession,
  ConfigWriteResponse,
  JsonValue,
  OwnedConfigValue,
} from "./codex-config/rpc-contract.ts";
export {
  canonicalExistingPath,
  configValueAt,
  restoreConfigEdits,
  sameConfigValue,
  selectedUserLayer,
  snapshotConfigValues,
  validateCodexBinary,
  valuesMatchAfter,
  valuesMatchBefore,
} from "./codex-config/values.ts";

async function openConfigRpcSession(options: {
  codexHome: string;
  codexBinary: string;
  dryRun?: boolean | undefined;
  rpcFactory?:
    | ((codexHome: string, codexBinary: string) => Promise<ConfigRpc>)
    | undefined;
  workspace?: RunWorkspace | undefined;
}): Promise<ConfigRpcSession> {
  const selectedHome = canonicalExistingPath(options.codexHome);
  const configPath = join(selectedHome, "config.toml");
  const owned =
    options.workspace === undefined && options.rpcFactory === undefined
      ? await createOwnedWorkspace()
      : undefined;
  const workspace = options.workspace ?? owned;
  if (!options.dryRun || options.rpcFactory) {
    try {
      const rpc = options.rpcFactory
        ? await options.rpcFactory(selectedHome, options.codexBinary)
        : await AppServerRpc.create(
            selectedHome,
            options.codexBinary,
            requiredWorkspace(workspace),
          );
      return {
        rpc,
        configPath,
        cleanup: () => closeOwnedWorkspace(owned),
      };
    } catch (error) {
      await closeOwnedWorkspace(owned, { error });
      throw error;
    }
  }
  try {
    const previewPath = requiredWorkspace(workspace).path("config-preview");
    mkdirSync(previewPath, { recursive: true, mode: 0o700 });
    const previewHome = realpathSync(previewPath);
    chmodSync(previewHome, 0o700);
    createConfigPreviewSnapshot(selectedHome, previewHome);
    const inner = await AppServerRpc.create(
      previewHome,
      options.codexBinary,
      requiredWorkspace(workspace),
    );
    return {
      rpc: new PreviewConfigRpc(inner, previewHome, selectedHome),
      configPath,
      cleanup: () => closeOwnedWorkspace(owned),
    };
  } catch (error) {
    await closeOwnedWorkspace(owned, { error });
    throw error;
  }
}

function requiredWorkspace(workspace: RunWorkspace | undefined): RunWorkspace {
  if (workspace === undefined) {
    throw new Error("installer operation requires a run workspace");
  }
  return workspace;
}

async function createOwnedWorkspace(): Promise<RunWorkspace> {
  const stale = await cleanupStale();
  if (stale.failed.length > 0 || stale.truncated) {
    throw new Error("installer stale workspace cleanup failed");
  }
  return await create();
}

async function closeOwnedWorkspace(
  workspace: RunWorkspace | undefined,
  operation?: { readonly error: unknown },
): Promise<void> {
  if (workspace === undefined) return;
  let report: Awaited<ReturnType<RunWorkspace["close"]>>;
  try {
    report = await workspace.close();
  } catch (cleanup) {
    throw new Error("installer temporary cleanup failed", {
      cause:
        operation === undefined
          ? cleanup
          : new AggregateError(
              [cleanup, operation.error],
              "workspace cleanup and config RPC acquisition both failed",
            ),
    });
  }
  if (report.state === "cleanup-failed") {
    const cleanup = new Error(
      `installer temporary cleanup failed: ${report.error ?? "CLEANUP_FAILED"}`,
    );
    throw new Error(cleanup.message, {
      cause:
        operation === undefined
          ? cleanup
          : new AggregateError(
              [cleanup, operation.error],
              "workspace cleanup and config RPC acquisition both failed",
            ),
    });
  }
}

export { openConfigRpcSession };
