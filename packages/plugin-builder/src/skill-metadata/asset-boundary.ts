import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ICON_ASSET_MAX_BYTES,
  type SkillAssetBinding,
  SkillMetadataError,
} from "./contract.ts";
import { readStableRegularFile } from "./regular-file-boundary.ts";

async function validateContainedAsset(
  root: string,
  directoryName: string,
  value: string,
  metadataPath: string,
  key: string,
): Promise<SkillAssetBinding> {
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    value.endsWith("/")
  ) {
    throw containmentError(metadataPath, key);
  }
  const normalizedParts = value
    .split("/")
    .filter((component) => component !== ".");
  if (normalizedParts.length < 2 || normalizedParts[0] !== "assets") {
    throw containmentError(metadataPath, key);
  }
  const skillRoot = resolve(root, "skills", directoryName);
  const assetPath = resolve(skillRoot, value);
  if (!isContained(skillRoot, assetPath)) {
    throw containmentError(metadataPath, key);
  }
  const assetRelativePath = relative(skillRoot, assetPath).split(sep).join("/");
  const distributedRelativePath = `skills/${directoryName}/${assetRelativePath}`;
  const bytes = await readStableRegularFile(
    root,
    distributedRelativePath,
    ICON_ASSET_MAX_BYTES,
  ).catch((error: unknown) => {
    if (error instanceof SkillMetadataError) {
      throw new SkillMetadataError(`${metadataPath}: ${key} ${error.message}`);
    }
    throw error;
  });
  return {
    bytes,
    relativePath: distributedRelativePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
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
