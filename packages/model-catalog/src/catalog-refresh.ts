import { join, resolve } from "node:path";
import { applyLunaV2Overlay, type LunaOverlay } from "./catalog-schema.ts";
import {
  cachedCatalog,
  digest,
  prepareCatalogStorePaths,
  validateCatalogStorePaths,
  writePrivateAtomic,
} from "./catalog-store.ts";
import {
  bundledCatalog,
  type CommandLimits,
  clientVersion,
  preflightCatalog,
} from "./codex-child.ts";

const DEFAULT_MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TERMINATION_GRACE_MS = 100;

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
  paths: CatalogPaths,
  limits: CommandLimits,
  now: Date,
): Promise<{
  source: CatalogSource;
  contents: string;
  overlay: LunaOverlay;
}> {
  const version = await clientVersion(paths.codexBinary, limits);
  const cached = await cachedCatalog(
    paths.cache,
    version,
    now,
    limits.maxStdoutBytes,
  );
  let source: CatalogSource = cached ? "cache" : "bundled";
  let sourceCatalog =
    cached ?? (await bundledCatalog(paths.codexBinary, limits));
  let overlaid = applyLunaV2Overlay(sourceCatalog);
  let contents = `${JSON.stringify(overlaid.catalog, null, 2)}\n`;
  try {
    await preflightCatalog(paths.codexBinary, contents, limits);
  } catch (error) {
    if (source !== "cache") {
      throw error;
    }
    source = "bundled";
    sourceCatalog = await bundledCatalog(paths.codexBinary, limits);
    overlaid = applyLunaV2Overlay(sourceCatalog);
    contents = `${JSON.stringify(overlaid.catalog, null, 2)}\n`;
    await preflightCatalog(paths.codexBinary, contents, limits);
  }
  return { source, contents, overlay: overlaid.overlay };
}

export async function refreshCatalog(
  options: CatalogRefreshOptions,
): Promise<CatalogRefreshResult> {
  const paths = resolveCatalogPaths(options);
  await prepareCatalogStorePaths(paths);
  const limits = commandLimits(options);
  const prepared = await preparedCatalog(
    paths,
    limits,
    options.now ?? new Date(),
  );
  await validateCatalogStorePaths(paths);
  const revalidatePaths = async (): Promise<void> =>
    validateCatalogStorePaths(paths);
  const updated = await writePrivateAtomic(paths.output, prepared.contents, {
    beforePromote: revalidatePaths,
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
  await writePrivateAtomic(
    paths.status,
    `${JSON.stringify(
      { ...result, checkedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    { beforePromote: revalidatePaths },
  );
  return result;
}
