import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OPENAI_METADATA_MAX_BYTES,
  SKILL_FILE_MAX_BYTES,
  SkillMetadataError,
  type SkillMetadataFile,
  type SkillMetadataRecord,
} from "./contract.ts";

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

  const entries = await readdir(skillsRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const records: SkillMetadataRecord[] = [];
  for (const entry of entries) {
    const entryPath = `skills/${entry.name}`;
    if (entry.name === ".DS_Store") {
      throw new SkillMetadataError(
        `${entryPath} looks like local or live state and cannot be packaged.`,
      );
    }
    if (entry.isSymbolicLink()) {
      throw new SkillMetadataError(`${entryPath}: is a symlink.`);
    }
    if (!entry.isDirectory()) {
      throw new SkillMetadataError(
        `${entryPath}: distributed skills root may contain only skill directories.`,
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: sorted sequential reads preserve deterministic first-failure diagnostics.
    const skill = await readBoundedFile(
      root,
      `${entryPath}/SKILL.md`,
      SKILL_FILE_MAX_BYTES,
    );
    // biome-ignore lint/performance/noAwaitInLoops: sorted sequential reads preserve deterministic first-failure diagnostics.
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

async function readBoundedFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
): Promise<SkillMetadataFile> {
  const absolutePath = join(root, ...relativePath.split("/"));
  await assertNoSymlinkComponents(root, relativePath);
  const metadata = await lstat(absolutePath).catch((error: unknown) => {
    throw filesystemError(error, relativePath);
  });
  if (!metadata.isFile()) {
    throw new SkillMetadataError(`${relativePath}: must be a regular file.`);
  }
  if (metadata.size === 0 || metadata.size > maximumBytes) {
    throw new SkillMetadataError(
      `${relativePath}: size must be between 1 and ${maximumBytes} bytes.`,
    );
  }
  return { bytes: await readFile(absolutePath), relativePath };
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

async function assertNoSymlinkComponents(
  root: string,
  relativePath: string,
): Promise<void> {
  let cursor = root;
  for (const part of relativePath.split("/")) {
    cursor = join(cursor, part);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: every ancestor must be checked before following the next component.
      metadata = await lstat(cursor);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw filesystemError(error, relativePath);
    }
    if (metadata.isSymbolicLink()) {
      throw new SkillMetadataError(`${relativePath}: is a symlink.`);
    }
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
