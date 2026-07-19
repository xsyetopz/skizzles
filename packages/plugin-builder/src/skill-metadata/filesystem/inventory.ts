import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { SKIPPED_WORKSPACE_DIRECTORIES } from "../../plugin/contract.ts";
import {
  ICON_ASSET_MAX_BYTES,
  type SkillAssetBinding,
  SkillMetadataError,
  type SkillMetadataRecord,
} from "../contract.ts";
import { containsUnsafePathCharacter, diagnosticPath } from "../diagnostic.ts";
import {
  filesystemBoundaryError,
  readStableRegularFile,
} from "./regular-file.ts";

const MAX_ASSET_DEPTH = 16;
const MAX_ASSET_FILES = 1000;

async function readSkillAssetInventory(
  root: string,
  records: readonly SkillMetadataRecord[],
  mode: "canonical" | "staged",
): Promise<readonly SkillAssetBinding[]> {
  const assets: SkillAssetBinding[] = [];
  for (const record of records) {
    const assetsPath = `skills/${record.directoryName}/assets`;
    // biome-ignore lint/performance/noAwaitInLoops: sorted skill ownership preserves deterministic diagnostics.
    const exists = await assetDirectoryExists(root, assetsPath);
    if (exists) {
      // biome-ignore lint/performance/noAwaitInLoops: each skill asset tree is validated as one ordered boundary.
      await readAssetDirectory(root, assetsPath, 0, assets, mode);
    }
  }
  return assets;
}

async function assetDirectoryExists(
  root: string,
  relativePath: string,
): Promise<boolean> {
  try {
    const metadata = await lstat(resolve(root, ...relativePath.split("/")));
    validateAssetDirectory(metadata, relativePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    if (error instanceof SkillMetadataError) {
      throw error;
    }
    throw filesystemBoundaryError(error, relativePath);
  }
}

async function readAssetDirectory(
  root: string,
  relativePath: string,
  depth: number,
  assets: SkillAssetBinding[],
  mode: "canonical" | "staged",
): Promise<void> {
  if (depth > MAX_ASSET_DEPTH) {
    throw new SkillMetadataError("Skill asset tree exceeds its depth limit.");
  }
  const absolutePath = resolve(root, ...relativePath.split("/"));
  const before = await lstat(absolutePath).catch((error: unknown) => {
    throw filesystemBoundaryError(error, relativePath);
  });
  validateAssetDirectory(before, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(
    (error: unknown) => {
      throw filesystemBoundaryError(error, relativePath);
    },
  );
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_WORKSPACE_DIRECTORIES.has(entry.name)) {
      if (mode === "staged") {
        throw new SkillMetadataError(
          "Staged skill assets contain an excluded workspace directory.",
        );
      }
      continue;
    }
    assertSafeAssetEntryName(entry.name);
    const entryPath = `${relativePath}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new SkillMetadataError(
        `${diagnosticPath(entryPath)}: asset entries must not be symlinks.`,
      );
    }
    if (entry.isDirectory()) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered traversal preserves deterministic first-failure diagnostics.
      await readAssetDirectory(root, entryPath, depth + 1, assets, mode);
      continue;
    }
    if (!entry.isFile()) {
      throw new SkillMetadataError(
        `${diagnosticPath(entryPath)}: asset entries must be regular files or directories.`,
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: stable reads bind every asset in deterministic path order.
    const bytes = await readStableRegularFile(
      root,
      entryPath,
      ICON_ASSET_MAX_BYTES,
    );
    assets.push({
      bytes,
      relativePath: entryPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    if (assets.length > MAX_ASSET_FILES) {
      throw new SkillMetadataError(
        "Skill asset inventory exceeds its file limit.",
      );
    }
  }
  const after = await lstat(absolutePath).catch((error: unknown) => {
    throw filesystemBoundaryError(error, relativePath);
  });
  validateAssetDirectory(after, relativePath);
  if (!sameDirectoryIdentity(before, after)) {
    throw new SkillMetadataError(
      `${diagnosticPath(relativePath)}: changed during asset inventory.`,
    );
  }
}

function validateAssetDirectory(
  metadata: Awaited<ReturnType<typeof lstat>>,
  relativePath: string,
): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new SkillMetadataError(
      `${diagnosticPath(relativePath)}: assets must be a self-contained directory.`,
    );
  }
}

function assertSafeAssetEntryName(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    containsUnsafePathCharacter(name)
  ) {
    throw new SkillMetadataError("Skill asset entry path is unsafe.");
  }
}

function sameDirectoryIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.nlink === right.nlink
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export { readSkillAssetInventory };
