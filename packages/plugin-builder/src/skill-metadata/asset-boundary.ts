import { isAbsolute, relative, resolve, sep } from "node:path";
import { ICON_ASSET_MAX_BYTES, SkillMetadataError } from "./contract.ts";
import { inspectStableRegularFile } from "./regular-file-boundary.ts";

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
  await inspectStableRegularFile(
    skillRoot,
    relative(skillRoot, assetPath).split(sep).join("/"),
    ICON_ASSET_MAX_BYTES,
  ).catch((error: unknown) => {
    if (error instanceof SkillMetadataError) {
      throw new SkillMetadataError(`${metadataPath}: ${key} ${error.message}`);
    }
    throw error;
  });
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
