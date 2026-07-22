import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  BLOCKED_CREDENTIAL_NAMES,
  BLOCKED_NAMES,
  BLOCKED_SUFFIXES,
  MACHINE_PATH_PATTERNS,
  PackagingError,
  SKIPPED_WORKSPACE_DIRECTORIES,
} from "./contract.ts";

export async function rejectForbiddenDistributableContent(
  pluginRoot: string,
): Promise<void> {
  for (const path of await listFiles(pluginRoot)) {
    const content = await readFile(join(pluginRoot, path));
    const text = content.toString("utf8");
    const match = MACHINE_PATH_PATTERNS.find((pattern) =>
      pattern.test(text),
    )?.exec(text)?.[0];
    if (match) {
      throw new PackagingError(
        `${path} contains machine-specific path ${match}.`,
      );
    }
  }
}

export async function copyCanonicalTree(
  sourceRoot: string,
  destinationRoot: string,
  label: string,
): Promise<void> {
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory()) {
    throw new PackagingError(`${label} must be a directory.`);
  }
  await mkdir(destinationRoot, { recursive: true });

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_WORKSPACE_DIRECTORIES.has(entry.name)) {
      continue;
    }
    assertDistributableName(entry.name, `${label}/${entry.name}`);
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    const sourceMetadata = await lstat(source);
    if (sourceMetadata.isSymbolicLink()) {
      throw new PackagingError(
        `${label}/${entry.name} is a symlink; distributable inputs must be self-contained.`,
      );
    }
    if (sourceMetadata.isDirectory()) {
      await copyCanonicalTree(source, destination, `${label}/${entry.name}`);
    } else if (sourceMetadata.isFile()) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else {
      throw new PackagingError(
        `${label}/${entry.name} is not a regular file or directory.`,
      );
    }
  }
}

export async function copyCanonicalFile(
  source: string,
  destination: string,
  label: string,
): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PackagingError(`${label} must be a self-contained regular file.`);
  }
  const name = source.split(sep).at(-1);
  if (name === undefined) {
    throw new PackagingError(`${label} has no distributable filename.`);
  }
  assertDistributableName(name, label);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, metadata.mode & 0o777);
}

export async function rejectFinderMetadata(
  root: string,
  label: string,
): Promise<void> {
  for (const path of await listFiles(root)) {
    if (path.split("/").includes(".DS_Store")) {
      throw new PackagingError(
        `${label} contains forbidden Finder metadata at ${path}.`,
      );
    }
  }
}

function assertDistributableName(name: string, path: string): void {
  const lowerName = name.toLowerCase();
  if (
    BLOCKED_NAMES.has(name) ||
    lowerName === ".env" ||
    lowerName.startsWith(".env.") ||
    BLOCKED_CREDENTIAL_NAMES.has(lowerName) ||
    BLOCKED_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))
  ) {
    throw new PackagingError(
      `${path} looks like local or live state and cannot be packaged.`,
    );
  }
}

export async function listFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) {
    throw new PackagingError(`${root} must be a directory.`);
  }
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new PackagingError(`${path} is an unsupported symlink.`);
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath);
      } else if (metadata.isFile()) {
        files.push(path);
      } else {
        throw new PackagingError(`${path} is not a regular file or directory.`);
      }
    }
  }

  await visit(root);
  return files;
}

export async function readJsonObject(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new PackagingError(
      `Unable to read ${label} at ${path}: ${String(error)}`,
    );
  }
  if (!isObject(value)) {
    throw new PackagingError(`${label} must contain a JSON object.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
