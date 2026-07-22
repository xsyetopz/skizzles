import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  OPENAI_METADATA_MAX_BYTES,
  SKILL_FILE_MAX_BYTES,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  SkillMetadataError,
  type SkillMetadataFile,
  type SkillMetadataRecord,
} from "../contract.ts";
import { readStableRegularFile } from "./regular-file.ts";

async function readSkillMetadata(
  root: string,
  label: "canonical" | "staged",
): Promise<SkillMetadataRecord[]> {
  const skillsRoot = join(root, "skills");
  const rootMetadata = await lstat(skillsRoot).catch((error: unknown) => {
    throw filesystemError(error, `${label} skills directory`);
  });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new SkillMetadataError(
      `${label} skills directory must be a self-contained directory.`,
    );
  }

  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      throw filesystemError(error, `${label} skills directory`);
    },
  );
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const records: SkillMetadataRecord[] = [];
  for (const entry of entries) {
    validateDirectoryName(entry.name);
    const entryPath = `skills/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new SkillMetadataError(`${entryPath}: is a symlink.`);
    }
    if (!entry.isDirectory()) {
      throw new SkillMetadataError(
        `${entryPath}: distributed skills root may contain only skill directories.`,
      );
    }

    const skill = await readBoundedFile(
      root,
      `${entryPath}/SKILL.md`,
      SKILL_FILE_MAX_BYTES,
    );
    const openai = await readOptionalBoundedFile(
      root,
      `${entryPath}/agents/openai.yaml`,
      OPENAI_METADATA_MAX_BYTES,
    );
    if (openai === undefined) {
      records.push({ directoryName: entry.name, skill });
    } else {
      records.push({ directoryName: entry.name, openai, skill });
    }
  }
  if (records.length === 0) {
    throw new SkillMetadataError(`${label} skills directory is empty.`);
  }
  return records;
}

function validateDirectoryName(name: string): void {
  if (name === ".DS_Store") {
    throw new SkillMetadataError(
      "skills/.DS_Store looks like local or live state and cannot be packaged.",
    );
  }
  if (
    [...name].length > SKILL_NAME_MAX_LENGTH ||
    !SKILL_NAME_PATTERN.test(name)
  ) {
    throw new SkillMetadataError(
      "Distributed skill directory name is invalid.",
    );
  }
}

async function readBoundedFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
): Promise<SkillMetadataFile> {
  return {
    bytes: await readStableRegularFile(root, relativePath, maximumBytes),
    relativePath,
  };
}

async function readOptionalBoundedFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
): Promise<SkillMetadataFile | undefined> {
  try {
    return await readBoundedFile(root, relativePath, maximumBytes);
  } catch (error) {
    if (
      error instanceof SkillMetadataError &&
      error.message.endsWith(": does not exist.")
    ) {
      return;
    }
    throw error;
  }
}

function filesystemError(error: unknown, path: string): SkillMetadataError {
  if (isNodeError(error) && error.code === "ENOENT") {
    return new SkillMetadataError(`${path}: does not exist.`);
  }
  return new SkillMetadataError(`${path}: cannot be inspected.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export { readSkillMetadata };
