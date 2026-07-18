import { createHash } from "node:crypto";
import { readSkillAssetInventory } from "./asset-inventory.ts";
import {
  type SkillAssetBinding,
  SkillMetadataError,
  type SkillMetadataRecord,
} from "./contract.ts";
import { readSkillMetadata } from "./discovery.ts";
import { validateOpenAiMetadata } from "./openai-metadata.ts";
import { validateSkillFile } from "./skill-file.ts";
import { sameStrings } from "./text-contract.ts";

async function validateCanonicalSkillMetadata(repoRoot: string): Promise<void> {
  const records = await readSkillMetadata(repoRoot, "canonical");
  await validateRecords(repoRoot, records, "canonical");
}

async function validateStagedSkillMetadata(
  repoRoot: string,
  stagedRoot: string,
): Promise<void> {
  const canonical = await readSkillMetadata(repoRoot, "canonical");
  const canonicalAssets = await validateRecords(
    repoRoot,
    canonical,
    "canonical",
  );
  const staged = await readStagedMetadata(stagedRoot);
  const stagedAssets = await validateRecords(stagedRoot, staged, "staged");
  assertMetadataParity(canonical, canonicalAssets, staged, stagedAssets);
}

async function readStagedMetadata(
  stagedRoot: string,
): Promise<SkillMetadataRecord[]> {
  try {
    return await readSkillMetadata(stagedRoot, "staged");
  } catch (error) {
    if (
      error instanceof SkillMetadataError &&
      error.message.includes("staged skills directory")
    ) {
      throw metadataSetError();
    }
    throw error;
  }
}

async function validateRecords(
  root: string,
  records: readonly SkillMetadataRecord[],
  mode: "canonical" | "staged",
): Promise<readonly SkillAssetBinding[]> {
  const names = new Set<string>();
  const inventory = await readSkillAssetInventory(root, records, mode);
  const assets = new Map(inventory.map((asset) => [asset.relativePath, asset]));
  for (const record of records) {
    const skillName = validateSkillFile(record);
    if (names.has(skillName)) {
      throw new SkillMetadataError(
        `${record.skill.relativePath}: duplicate skill name ${skillName}.`,
      );
    }
    names.add(skillName);
    if (record.openai !== undefined) {
      // biome-ignore lint/performance/noAwaitInLoops: sorted sequential validation preserves deterministic first-failure diagnostics.
      const recordAssets = await validateOpenAiMetadata(
        root,
        record.directoryName,
        record.openai,
      );
      for (const asset of recordAssets) {
        const inventoried = assets.get(asset.relativePath);
        if (
          inventoried === undefined ||
          inventoried.sha256 !== asset.sha256 ||
          !Buffer.from(inventoried.bytes).equals(Buffer.from(asset.bytes))
        ) {
          throw new SkillMetadataError(
            `${asset.relativePath}: referenced icon is not bound to the asset inventory.`,
          );
        }
      }
    }
  }
  return [...assets.values()];
}

function assertMetadataParity(
  canonical: readonly SkillMetadataRecord[],
  canonicalAssets: readonly SkillAssetBinding[],
  staged: readonly SkillMetadataRecord[],
  stagedAssets: readonly SkillAssetBinding[],
): void {
  const canonicalFiles = flattenMetadata(canonical, canonicalAssets);
  const stagedFiles = flattenMetadata(staged, stagedAssets);
  const canonicalPaths = [...canonicalFiles.keys()].sort();
  const stagedPaths = [...stagedFiles.keys()].sort();
  if (!sameStrings(canonicalPaths, stagedPaths)) {
    throw metadataSetError();
  }
  for (const path of canonicalPaths) {
    const source = canonicalFiles.get(path);
    const destination = stagedFiles.get(path);
    if (
      source === undefined ||
      destination === undefined ||
      source.sha256 !== destination.sha256 ||
      !Buffer.from(source.bytes).equals(Buffer.from(destination.bytes))
    ) {
      throw new SkillMetadataError(
        `${path}: staged skill metadata differs from canonical bytes, including bound assets.`,
      );
    }
  }
}

function flattenMetadata(
  records: readonly SkillMetadataRecord[],
  assets: readonly SkillAssetBinding[],
): Map<string, SkillAssetBinding> {
  const files = new Map<string, SkillAssetBinding>();
  for (const record of records) {
    files.set(record.skill.relativePath, bindFile(record.skill));
    if (record.openai !== undefined) {
      files.set(record.openai.relativePath, bindFile(record.openai));
    }
  }
  for (const asset of assets) {
    files.set(asset.relativePath, asset);
  }
  return files;
}

function bindFile(file: {
  bytes: Uint8Array;
  relativePath: string;
}): SkillAssetBinding {
  return {
    ...file,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  };
}

function metadataSetError(): SkillMetadataError {
  return new SkillMetadataError(
    "staged skill metadata set differs from canonical skill metadata.",
  );
}

export { validateCanonicalSkillMetadata, validateStagedSkillMetadata };
