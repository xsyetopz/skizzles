import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SkillMetadataError } from "./contract.ts";

async function validateContainedAsset(
  root: string,
  directoryName: string,
  value: string,
  metadataPath: string,
  key: string,
): Promise<void> {
  if (
    !value.startsWith("./") ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    value.endsWith("/")
  ) {
    throw containmentError(metadataPath, key);
  }
  const skillRoot = resolve(root, "skills", directoryName);
  const assetPath = resolve(skillRoot, value);
  if (!isContained(skillRoot, assetPath)) {
    throw containmentError(metadataPath, key);
  }
  const pathParts = relative(skillRoot, assetPath).split(sep);
  let cursor = skillRoot;
  for (const part of pathParts) {
    cursor = join(cursor, part);
    // biome-ignore lint/performance/noAwaitInLoops: containment requires checking each path component without following a symlink.
    const metadata = await lstat(cursor).catch(() => {
      throw new SkillMetadataError(
        `${metadataPath}: ${key} must reference an existing regular file.`,
      );
    });
    if (metadata.isSymbolicLink()) {
      throw new SkillMetadataError(`${metadataPath}: ${key} is a symlink.`);
    }
  }
  const metadata = await lstat(assetPath);
  if (!metadata.isFile()) {
    throw new SkillMetadataError(
      `${metadataPath}: ${key} must reference a regular file.`,
    );
  }
  const resolvedSkillRoot = await realpath(skillRoot);
  const resolvedAsset = await realpath(assetPath);
  if (!isContained(resolvedSkillRoot, resolvedAsset)) {
    throw containmentError(metadataPath, key);
  }
}

function containmentError(
  metadataPath: string,
  key: string,
): SkillMetadataError {
  return new SkillMetadataError(
    `${metadataPath}: ${key} must be a contained relative asset path.`,
  );
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

export { validateContainedAsset };
