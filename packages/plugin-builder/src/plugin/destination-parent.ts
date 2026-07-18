import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rmdir,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { PackagingError } from "./contract.ts";

const CREATED_PARENT_MODE = 0o755;

interface OwnedParent {
  dev: bigint;
  ino: bigint;
  path: string;
}

async function ensureDestinationParent(
  destinationInput: string,
  afterCreate?: (path: string) => Promise<void> | void,
): Promise<OwnedParent[]> {
  let parent: string;
  try {
    parent = dirname(resolve(destinationInput));
  } catch (error) {
    throw new PackagingError("Plugin staging destination is unsafe.", {
      cause: error,
    });
  }
  const owned: OwnedParent[] = [];
  try {
    const missing: string[] = [];
    let existing = parent;
    while (!(await pathExists(existing))) {
      missing.push(existing);
      const ancestor = dirname(existing);
      if (ancestor === existing) throw unsafeDestinationAncestorError();
      existing = ancestor;
    }
    await assertLexicalAncestors(existing);
    let physicalParent = await realpath(existing);
    for (const lexicalPath of missing.reverse()) {
      physicalParent = join(physicalParent, basename(lexicalPath));
      try {
        await mkdir(physicalParent, { mode: CREATED_PARENT_MODE });
        const created = await lstatBigInt(physicalParent);
        owned.push({
          dev: created.dev,
          ino: created.ino,
          path: physicalParent,
        });
        await afterCreate?.(physicalParent);
      } catch (error) {
        if (!(isNodeError(error) && error.code === "EEXIST")) {
          throw unsafeDestinationAncestorError(error);
        }
      }
      const metadata = await lstatBigInt(physicalParent);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw unsafeDestinationAncestorError();
      }
    }
    return owned;
  } catch (error) {
    await cleanupOwnedParents(owned);
    throw error instanceof PackagingError
      ? error
      : unsafeDestinationAncestorError(error);
  }
}

async function cleanupOwnedParents(
  parents: readonly OwnedParent[],
): Promise<void> {
  for (const parent of [...parents].reverse()) {
    await cleanupOwnedParent(parent);
  }
}

async function cleanupOwnedParent(parent: OwnedParent): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstatBigInt>>;
  try {
    metadata = await lstatBigInt(parent.path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.dev !== parent.dev ||
      metadata.ino !== parent.ino ||
      (await readdir(parent.path)).length > 0
    ) {
      return;
    }
  } catch {
    return;
  }
  const quarantine = `${parent.path}.skizzles-parent-cleanup-${randomUUID()}`;
  try {
    await rename(parent.path, quarantine);
    metadata = await lstatBigInt(quarantine);
    if (metadata.dev !== parent.dev || metadata.ino !== parent.ino) {
      await restoreQuarantinedParent(quarantine, parent.path);
      return;
    }
    await rmdir(quarantine);
  } catch {
    await restoreQuarantinedParent(quarantine, parent.path);
  }
}

async function restoreQuarantinedParent(
  quarantine: string,
  path: string,
): Promise<void> {
  try {
    await lstatBigInt(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await rename(quarantine, path).catch(() => undefined);
    }
  }
}

async function assertLexicalAncestors(parent: string): Promise<void> {
  const { root } = parse(parent);
  const suffix = relative(root, parent);
  const components = suffix === "" ? [] : suffix.split(sep);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let metadata: Awaited<ReturnType<typeof lstatBigInt>>;
    try {
      metadata = await lstatBigInt(current);
    } catch (error) {
      throw unsafeDestinationAncestorError(error);
    }
    const rootAlias = metadata.isSymbolicLink() && dirname(current) === root;
    if (
      (!rootAlias && metadata.isSymbolicLink()) ||
      !(metadata.isSymbolicLink() || metadata.isDirectory())
    ) {
      throw unsafeDestinationAncestorError();
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstatBigInt(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw unsafeDestinationAncestorError(error);
  }
}

function unsafeDestinationAncestorError(cause?: unknown): PackagingError {
  const message =
    "Plugin staging destination ancestors must be existing real directories.";
  return cause === undefined
    ? new PackagingError(message)
    : new PackagingError(message, { cause });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const lockedDestinationError = () =>
  new PackagingError(
    "Plugin staging destination is locked by another operation.",
  );

const lstatBigInt = (path: string) => lstat(path, { bigint: true });

export type { OwnedParent };
export {
  assertLexicalAncestors,
  cleanupOwnedParents,
  ensureDestinationParent,
  isNodeError,
  lockedDestinationError,
  lstatBigInt,
  unsafeDestinationAncestorError,
};
