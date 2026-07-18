import { createHash } from "node:crypto";
import { realpath, rename } from "node:fs/promises";
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
import type { TransactionJournal } from "./destination-journal.ts";
import { PROTOCOL_VERSION, serialized } from "./destination-journal.ts";
import {
  assertLexicalAncestors,
  isNodeError,
  lstatBigInt,
  unsafeDestinationAncestorError,
} from "./destination-parent.ts";

const DESTINATION_KEY_LENGTH = 16;

interface FileIdentity {
  dev: bigint;
  ino: bigint;
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
    let metadata: Awaited<ReturnType<typeof lstatBigInt>>;
    try {
      metadata = await lstatBigInt(current);
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
    let metadata: Awaited<ReturnType<typeof lstatBigInt>>;
    try {
      metadata = await lstatBigInt(snapshot.path);
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
  let metadata: Awaited<ReturnType<typeof lstatBigInt>>;
  try {
    metadata = await lstatBigInt(path);
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

async function assertPathIdentity(
  path: string,
  expected: FileIdentity | undefined,
): Promise<void> {
  if (expected === undefined) {
    throw new PackagingError("Plugin staging path identity is unavailable.");
  }
  const metadata = await lstatBigInt(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !sameIdentity(expected, identity(metadata))
  ) {
    throw new PackagingError("Plugin staging path identity changed.");
  }
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstatBigInt(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new PackagingError(
    "Plugin staging destination changed during rollback.",
  );
}

function identity(
  metadata: Awaited<ReturnType<typeof lstatBigInt>>,
): FileIdentity {
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

function transactionLockPath(target: TransactionTarget): string {
  return join(target.parent, `.skizzles-package-${target.key}.lock`);
}

function privateSiblingPath(
  target: TransactionTarget,
  kind: "backup" | "stage",
  token: string,
): string {
  return join(
    target.parent,
    `.skizzles-package-${target.key}-${kind}-${token}`,
  );
}

function initialJournal(original: DestinationSnapshot): TransactionJournal {
  return {
    version: PROTOCOL_VERSION,
    state: "active",
    original:
      original.identity === undefined
        ? { present: false }
        : { identity: serialized(original.identity), present: true },
  };
}

async function restoreQuarantinedPath(
  quarantine: string,
  original: string,
): Promise<void> {
  try {
    await assertPathAbsent(original);
    await rename(quarantine, original);
  } catch {}
}

function changedRecoveryDestinationError(): PackagingError {
  return new PackagingError(
    "Plugin staging recovery found a changed destination.",
  );
}

export type {
  DestinationSnapshot,
  FileIdentity,
  PathSnapshot,
  TransactionTarget,
};
export {
  assertDestinationUnchanged,
  assertPathAbsent,
  assertPathIdentity,
  changedDestinationError,
  changedRecoveryDestinationError,
  identity,
  initialJournal,
  inspectDestination,
  inspectTarget,
  privateSiblingPath,
  restoreQuarantinedPath,
  revalidateAncestors,
  sameIdentity,
  transactionLockPath,
};
