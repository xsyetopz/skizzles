import { lstat, mkdir, realpath } from "node:fs/promises";
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

async function ensureDestinationParent(
  destinationInput: string,
): Promise<void> {
  let parent: string;
  try {
    parent = dirname(resolve(destinationInput));
  } catch (error) {
    throw new PackagingError("Plugin staging destination is unsafe.", {
      cause: error,
    });
  }
  const missing: string[] = [];
  let existing = parent;
  // biome-ignore lint/performance/noAwaitInLoops: missing parents are discovered from the leaf to the first verified ancestor.
  while (!(await pathExists(existing))) {
    missing.push(existing);
    const ancestor = dirname(existing);
    if (ancestor === existing) {
      throw unsafeDestinationAncestorError();
    }
    existing = ancestor;
  }
  await assertLexicalAncestors(existing);
  let physicalParent: string;
  try {
    physicalParent = await realpath(existing);
  } catch (error) {
    throw unsafeDestinationAncestorError(error);
  }
  for (const lexicalPath of missing.reverse()) {
    physicalParent = join(physicalParent, basename(lexicalPath));
    try {
      // biome-ignore lint/performance/noAwaitInLoops: parents are created and verified in containment order.
      await mkdir(physicalParent, { mode: CREATED_PARENT_MODE });
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) {
        throw unsafeDestinationAncestorError(error);
      }
    }
    const metadata = await lstat(physicalParent);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw unsafeDestinationAncestorError();
    }
  }
}

async function assertLexicalAncestors(parent: string): Promise<void> {
  const { root } = parse(parent);
  const suffix = relative(root, parent);
  let components: string[] = [];
  if (suffix !== "") {
    components = suffix.split(sep);
  }
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: every caller-supplied component must be classified before canonicalization.
      metadata = await lstat(current);
    } catch (error) {
      throw unsafeDestinationAncestorError(error);
    }
    const isPlatformRootAlias =
      metadata.isSymbolicLink() && dirname(current) === root;
    if (
      (!isPlatformRootAlias && metadata.isSymbolicLink()) ||
      !(metadata.isSymbolicLink() || metadata.isDirectory())
    ) {
      throw unsafeDestinationAncestorError();
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw unsafeDestinationAncestorError(error);
  }
}

function unsafeDestinationAncestorError(cause?: unknown): PackagingError {
  if (cause !== undefined) {
    return new PackagingError(
      "Plugin staging destination ancestors must be existing real directories.",
      { cause },
    );
  }
  return new PackagingError(
    "Plugin staging destination ancestors must be existing real directories.",
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export {
  assertLexicalAncestors,
  ensureDestinationParent,
  unsafeDestinationAncestorError,
};
