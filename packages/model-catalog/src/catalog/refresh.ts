import { join, resolve } from "node:path";
import {
  cleanupStale,
  create,
  type RunWorkspace,
} from "@skizzles/run-workspace";
import {
  bundledCatalog,
  CodexChildError,
  type CodexRuntime,
  type CommandLimits,
  clientVersion,
  preflightCatalog,
  requireOwnedProcessScope,
  systemCodexRuntime,
} from "../codex/child.ts";
import { applyLunaV2Overlay, type LunaOverlay } from "./schema.ts";
import {
  cachedCatalog,
  digest,
  prepareCatalogStorePaths,
  validateCatalogStorePaths,
  writePrivateAtomic,
} from "./store.ts";

const DEFAULT_MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TERMINATION_GRACE_MS = 100;
const WORKSPACE_FORCE_STOP_MS = 2_500;

export type CatalogSource = "cache" | "bundled";

export interface CatalogRefreshOptions {
  codexHome: string;
  codexBinary: string;
  output?: string;
  status?: string;
  cache?: string;
  now?: Date;
  commandTimeoutMs?: number;
  maxCatalogBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
}

export interface CatalogRefreshResult {
  ok: true;
  source: CatalogSource;
  updated: boolean;
  lunaOverlay: LunaOverlay;
  catalogChanged: boolean;
  generation: string;
  output: string;
}

export interface CatalogPaths {
  codexHome: string;
  codexBinary: string;
  output: string;
  status: string;
  cache: string;
}

export interface CatalogRefreshCommitHooks {
  beforeOutputPromote?: () => Promise<void>;
  afterOutputCommit?: () => Promise<void>;
}

export interface CatalogRefreshRuntime {
  readonly codex: CodexRuntime;
  readonly commitHooks?: CatalogRefreshCommitHooks;
}

const systemCatalogRefreshRuntime: CatalogRefreshRuntime = {
  codex: systemCodexRuntime,
};

export function resolveCatalogPaths(
  options: CatalogRefreshOptions,
): CatalogPaths {
  const codexHome = resolve(options.codexHome);
  const paths = {
    codexHome,
    codexBinary: resolve(options.codexBinary),
    output: resolve(
      options.output ?? join(codexHome, "skizzles", "model-catalog.json"),
    ),
    status: resolve(
      options.status ??
        join(codexHome, "skizzles", "model-catalog-status.json"),
    ),
    cache: resolve(options.cache ?? join(codexHome, "models_cache.json")),
  };
  const distinct = new Set([paths.output, paths.status, paths.cache]);
  if (distinct.size !== 3) {
    throw new Error("catalog output, status, and cache paths must be distinct");
  }
  return paths;
}

function commandLimits(options: CatalogRefreshOptions): CommandLimits {
  const limits = {
    timeoutMs: options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    terminationGraceMs: DEFAULT_TERMINATION_GRACE_MS,
    maxStdoutBytes: options.maxCatalogBytes ?? DEFAULT_MAX_CATALOG_BYTES,
    maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
  };
  if (
    !Object.values(limits).every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new Error("catalog command limits must be positive safe integers");
  }
  return limits;
}

async function preparedCatalog(
  workspace: RunWorkspace,
  paths: CatalogPaths,
  limits: CommandLimits,
  now: Date,
  runtime: CodexRuntime,
): Promise<{
  source: CatalogSource;
  contents: string;
  overlay: LunaOverlay;
}> {
  const version = await clientVersion(
    workspace,
    paths.codexBinary,
    limits,
    runtime,
  );
  const cached = await cachedCatalog(
    paths.cache,
    version,
    now,
    limits.maxStdoutBytes,
  );
  let source: CatalogSource = cached ? "cache" : "bundled";
  let sourceCatalog =
    cached ??
    (await bundledCatalog(workspace, paths.codexBinary, limits, runtime));
  let overlaid = applyLunaV2Overlay(sourceCatalog);
  let contents = `${JSON.stringify(overlaid.catalog, null, 2)}\n`;
  try {
    await preflightCatalog(
      workspace,
      paths.codexBinary,
      contents,
      limits,
      runtime,
    );
  } catch (error) {
    if (source !== "cache") {
      throw error;
    }
    source = "bundled";
    sourceCatalog = await bundledCatalog(
      workspace,
      paths.codexBinary,
      limits,
      runtime,
    );
    overlaid = applyLunaV2Overlay(sourceCatalog);
    contents = `${JSON.stringify(overlaid.catalog, null, 2)}\n`;
    await preflightCatalog(
      workspace,
      paths.codexBinary,
      contents,
      limits,
      runtime,
    );
  }
  return { source, contents, overlay: overlaid.overlay };
}

export async function refreshCatalog(
  options: CatalogRefreshOptions,
): Promise<CatalogRefreshResult> {
  return await refreshCatalogWithRuntime(options, systemCatalogRefreshRuntime);
}

export async function refreshCatalogWithRuntime(
  options: CatalogRefreshOptions,
  runtime: CatalogRefreshRuntime,
): Promise<CatalogRefreshResult> {
  const paths = resolveCatalogPaths(options);
  const limits = commandLimits(options);
  requireOwnedProcessScope(runtime.codex.platform);
  let workspace: RunWorkspace;
  try {
    const stale = await cleanupStale();
    if (stale.failed.length > 0) {
      throw new CodexChildError("lifecycle");
    }
    const workspaceOptions = {
      gracefulStopMs: limits.terminationGraceMs,
      forceStopMs: WORKSPACE_FORCE_STOP_MS,
    };
    workspace =
      options.signal === undefined
        ? await create(workspaceOptions)
        : await create({ ...workspaceOptions, signal: options.signal });
  } catch {
    throw new CodexChildError("lifecycle");
  }
  let outcome:
    | { readonly ok: true; readonly result: CatalogRefreshResult }
    | { readonly ok: false; readonly error: unknown };
  try {
    await prepareCatalogStorePaths(paths);
    const prepared = await preparedCatalog(
      workspace,
      paths,
      limits,
      options.now ?? new Date(),
      runtime.codex,
    );
    await validateCatalogStorePaths(paths);
    const revalidatePaths = async (): Promise<void> =>
      validateCatalogStorePaths(paths);
    const requireActive = (): void => {
      if (workspace.signal.aborted) {
        throw new CodexChildError("cancelled");
      }
    };
    requireActive();
    const updated = await writePrivateAtomic(paths.output, prepared.contents, {
      beforePromote: async () => {
        await revalidatePaths();
        await runtime.commitHooks?.beforeOutputPromote?.();
        requireActive();
      },
    });
    const result: CatalogRefreshResult = {
      ok: true,
      source: prepared.source,
      updated,
      lunaOverlay: prepared.overlay,
      catalogChanged: updated,
      generation: digest(prepared.contents),
      output: paths.output,
    };
    await runtime.commitHooks?.afterOutputCommit?.();
    await writePrivateAtomic(
      paths.status,
      `${JSON.stringify(
        { ...result, checkedAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
      { beforePromote: revalidatePaths },
    );
    outcome = { ok: true, result };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let cleanupSucceeded = false;
  try {
    cleanupSucceeded = (await workspace.close()).state === "deleted";
  } catch {
    // A deterministic lifecycle error below replaces any operation outcome.
  }
  if (!cleanupSucceeded) {
    throw new CodexChildError("lifecycle");
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.result;
}
