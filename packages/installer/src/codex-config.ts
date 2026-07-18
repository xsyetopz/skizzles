import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export async function openConfigRpcSession(options: {
  codexHome: string;
  codexBinary: string;
  dryRun?: boolean | undefined;
  rpcFactory?:
    | ((codexHome: string, codexBinary: string) => Promise<ConfigRpc>)
    | undefined;
}): Promise<ConfigRpcSession> {
  const selectedHome = canonicalExistingPath(options.codexHome);
  const configPath = join(selectedHome, "config.toml");
  if (!options.dryRun || options.rpcFactory) {
    return {
      rpc: await (options.rpcFactory ?? AppServerRpc.create)(
        selectedHome,
        options.codexBinary,
      ),
      configPath,
      cleanup: noRpcCleanup,
    };
  }
  const previewHome = realpathSync(
    mkdtempSync(join(tmpdir(), "skizzles-config-preview-")),
  );
  chmodSync(previewHome, 0o700);
  try {
    createConfigPreviewSnapshot(selectedHome, previewHome);
    const inner = await AppServerRpc.create(previewHome, options.codexBinary);
    return {
      rpc: new PreviewConfigRpc(inner, previewHome, selectedHome),
      configPath,
      cleanup: () => rmSync(previewHome, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(previewHome, { recursive: true, force: true });
    throw error;
  }
}

function noRpcCleanup(): void {
  // A non-preview RPC has no disposable home.
}
