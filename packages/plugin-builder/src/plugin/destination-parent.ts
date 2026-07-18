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
const DECIMAL_IDENTITY_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

interface OwnedParent {
  dev: bigint;
  ino: bigint;
  path: string;
}

interface LockOwner {
  pid: number;
  processStartIdentity: string;
  token: string;
  version: number;
}

interface SerializedIdentity {
  dev: string;
  ino: string;
}

type JournalState = "active" | "committed" | "cleanup-pending";

interface TransactionJournal {
  backup?: SerializedIdentity;
  original: { identity?: SerializedIdentity; present: boolean };
  stage?: SerializedIdentity;
  state: JournalState;
  version: number;
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
    // biome-ignore lint/performance/noAwaitInLoops: discovery must stop at the first verified existing ancestor.
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
        // biome-ignore lint/performance/noAwaitInLoops: parents are created and verified in containment order.
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
    // biome-ignore lint/performance/noAwaitInLoops: owned parents are released leaf-first.
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
      // biome-ignore lint/performance/noAwaitInLoops: every caller-supplied component is classified before canonicalization.
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

function serialized(value: { dev: bigint; ino: bigint }): SerializedIdentity {
  return { dev: String(value.dev), ino: String(value.ino) };
}

function deserialize(value: SerializedIdentity | undefined) {
  if (value === undefined) return;
  return { dev: BigInt(value.dev), ino: BigInt(value.ino) };
}

function matches(
  actual: { dev: bigint; ino: bigint } | undefined,
  expected: SerializedIdentity | undefined,
): boolean {
  return (
    actual !== undefined &&
    expected !== undefined &&
    String(actual.dev) === expected.dev &&
    String(actual.ino) === expected.ino
  );
}

const lstatBigInt = (path: string) => lstat(path, { bigint: true });

function parseJournal(value: unknown, version: number): TransactionJournal {
  const record = requiredRecord(value);
  const original = requiredRecord(record["original"]);
  const state = record["state"];
  if (
    Object.keys(record).length !==
      3 + Number("backup" in record) + Number("stage" in record) ||
    Object.keys(original).length !== 1 + Number("identity" in original) ||
    record["version"] !== version ||
    typeof original["present"] !== "boolean" ||
    !isJournalState(state)
  ) {
    throw new Error("invalid journal");
  }
  const journal: TransactionJournal = {
    version,
    state,
    original: { present: original["present"] },
  };
  const prior = parseIdentity(original["identity"]);
  const stage = parseIdentity(record["stage"]);
  const backup = parseIdentity(record["backup"]);
  if (prior !== undefined) journal.original.identity = prior;
  if (stage !== undefined) journal.stage = stage;
  if (backup !== undefined) journal.backup = backup;
  return journal;
}

function parseIdentity(value: unknown): SerializedIdentity | undefined {
  if (value === undefined) return;
  const record = requiredRecord(value);
  if (
    Object.keys(record).length !== 2 ||
    typeof record["dev"] !== "string" ||
    typeof record["ino"] !== "string" ||
    !DECIMAL_IDENTITY_PATTERN.test(record["dev"]) ||
    !DECIMAL_IDENTITY_PATTERN.test(record["ino"])
  ) {
    throw new Error("invalid identity");
  }
  return { dev: record["dev"], ino: record["ino"] };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid record");
  }
  return Object.fromEntries(Object.entries(value));
}

function isJournalState(value: unknown): value is JournalState {
  return (
    typeof value === "string" &&
    ["active", "committed", "cleanup-pending"].includes(value)
  );
}

export type { LockOwner, OwnedParent, SerializedIdentity, TransactionJournal };
export {
  assertLexicalAncestors,
  cleanupOwnedParents,
  deserialize,
  ensureDestinationParent,
  isNodeError,
  lstatBigInt,
  matches,
  parseJournal,
  requiredRecord,
  serialized,
  unsafeDestinationAncestorError,
};
