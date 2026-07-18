import { SkillMetadataError, type SkillMetadataRecord } from "./contract.ts";
import { readSkillMetadata } from "./discovery.ts";
import { validateOpenAiMetadata } from "./openai-metadata.ts";
import { validateSkillFile } from "./skill-file.ts";
import { sameStrings } from "./text-contract.ts";

async function validateCanonicalSkillMetadata(repoRoot: string): Promise<void> {
  const records = await readSkillMetadata(repoRoot, "canonical");
  await validateRecords(repoRoot, records);
}

async function validateStagedSkillMetadata(
  repoRoot: string,
  stagedRoot: string,
): Promise<void> {
  const canonical = await readSkillMetadata(repoRoot, "canonical");
  await validateRecords(repoRoot, canonical);
  const staged = await readStagedMetadata(stagedRoot);
  assertMetadataParity(canonical, staged);
  await validateRecords(stagedRoot, staged);
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
): Promise<void> {
  const names = new Set<string>();
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
      await validateOpenAiMetadata(root, record.directoryName, record.openai);
    }
  }
}

function assertMetadataParity(
  canonical: readonly SkillMetadataRecord[],
  staged: readonly SkillMetadataRecord[],
): void {
  const canonicalFiles = flattenMetadata(canonical);
  const stagedFiles = flattenMetadata(staged);
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
      !Buffer.from(source).equals(Buffer.from(destination))
    ) {
      throw new SkillMetadataError(
        `${path}: staged skill metadata differs from canonical bytes.`,
      );
    }
  }
}

function flattenMetadata(
  records: readonly SkillMetadataRecord[],
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const record of records) {
    files.set(record.skill.relativePath, record.skill.bytes);
    if (record.openai !== undefined) {
      files.set(record.openai.relativePath, record.openai.bytes);
    }
  }
  return files;
}

function metadataSetError(): SkillMetadataError {
  return new SkillMetadataError(
    "staged skill metadata set differs from canonical skill metadata.",
  );
}

export { validateCanonicalSkillMetadata, validateStagedSkillMetadata };
