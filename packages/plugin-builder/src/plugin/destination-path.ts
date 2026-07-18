import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
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
import {
  assertLexicalAncestors,
  unsafeDestinationAncestorError,
} from "./destination-parent.ts";

const DESTINATION_KEY_LENGTH = 16;

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

interface PathSnapshot {
  identity: FileIdentity;
  path: string;
}

interface DestinationSnapshot {
  identity?: FileIdentity;
  present: boolean;
}

interface TransactionTarget {
  ancestors: readonly PathSnapshot[];
  destination: string;
  key: string;
  parent: string;
}

async function inspectTarget(
  destinationInput: string,
): Promise<TransactionTarget> {
  let destination: string;
  try {
    destination = resolve(destinationInput);
  } catch (error) {
    throw new PackagingError("Plugin staging destination is unsafe.", {
      cause: error,
    });
  }
  const lexicalParent = dirname(destination);
  if (destination === parse(destination).root || basename(destination) === "") {
    throw new PackagingError("Plugin staging destination is unsafe.");
  }
  await assertLexicalAncestors(lexicalParent);
  let parent: string;
  try {
    parent = await realpath(lexicalParent);
  } catch (error) {
    throw unsafeDestinationAncestorError(error);
  }
  destination = join(parent, basename(destination));
  return {
    ancestors: await snapshotAncestors(parent),
    destination,
    key: createHash("sha256")
      .update(destination)
      .digest("hex")
      .slice(0, DESTINATION_KEY_LENGTH),
    parent,
  };
}

async function snapshotAncestors(parent: string): Promise<PathSnapshot[]> {
  const { root } = parse(parent);
  const suffix = relative(root, parent);
  let components: string[] = [];
  if (suffix !== "") {
    components = suffix.split(sep);
  }
  const snapshots: PathSnapshot[] = [];
  let current = root;
  for (const component of ["", ...components]) {
    if (component !== "") {
      current = join(current, component);
    }
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: ordered ancestor inspection is the destination containment boundary.
      metadata = await lstat(current);
    } catch (error) {
      throw unsafeDestinationAncestorError(error);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw unsafeDestinationAncestorError();
    }
    snapshots.push({ path: current, identity: identity(metadata) });
  }
  return snapshots;
}

async function revalidateAncestors(
  ancestors: readonly PathSnapshot[],
): Promise<void> {
  for (const snapshot of ancestors) {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: ordered identity checks fail closed before pathname mutation.
      metadata = await lstat(snapshot.path);
    } catch (error) {
      throw changedAncestorError(error);
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !sameIdentity(snapshot.identity, identity(metadata))
    ) {
      throw changedAncestorError();
    }
  }
}

async function inspectDestination(path: string): Promise<DestinationSnapshot> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { present: false };
    }
    throw new PackagingError(
      "Plugin staging destination could not be inspected safely.",
      { cause: error },
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PackagingError(
      "Plugin staging destination must be a real directory or absent.",
    );
  }
  return { present: true, identity: identity(metadata) };
}

async function assertDestinationUnchanged(
  path: string,
  expected: DestinationSnapshot,
): Promise<void> {
  const actual = await inspectDestination(path);
  if (actual.present !== expected.present) {
    throw changedDestinationError();
  }
  if (!expected.present) {
    return;
  }
  if (
    expected.identity === undefined ||
    actual.identity === undefined ||
    !sameIdentity(expected.identity, actual.identity)
  ) {
    throw changedDestinationError();
  }
}

function identity(metadata: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function changedAncestorError(cause?: unknown): PackagingError {
  if (cause !== undefined) {
    return new PackagingError(
      "Plugin staging destination ancestors changed during the transaction.",
      { cause },
    );
  }
  return new PackagingError(
    "Plugin staging destination ancestors changed during the transaction.",
  );
}

function changedDestinationError(): PackagingError {
  return new PackagingError(
    "Plugin staging destination changed during the transaction.",
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export type {
  DestinationSnapshot,
  FileIdentity,
  PathSnapshot,
  TransactionTarget,
};
export {
  assertDestinationUnchanged,
  identity,
  inspectDestination,
  inspectTarget,
  revalidateAncestors,
  sameIdentity,
};
