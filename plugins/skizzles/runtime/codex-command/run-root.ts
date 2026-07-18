import type { Stats } from "node:fs";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type FileIdentity = {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  size: number;
  mtimeMs: number;
};

function currentUid(): number | undefined {
  return process.getuid?.();
}

export function identity(info: Stats): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

export function sameDirectoryNode(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode
  );
}

function ownedByCurrentUser(info: Stats): boolean {
  const uid = currentUid();
  return uid === undefined || info.uid === uid;
}

function hasMode(info: Stats, mode: number): boolean {
  return (info.mode & 0o777) === mode;
}

export function isOwnedDirectory(info: Stats, mode: number): boolean {
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    ownedByCurrentUser(info) &&
    hasMode(info, mode)
  );
}

export function isOwnedRegularFile(info: Stats, mode: number): boolean {
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    ownedByCurrentUser(info) &&
    hasMode(info, mode)
  );
}

function trustedParent(path: string): string {
  const physical = realpathSync(path);
  const info = lstatSync(physical);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("run root parent is not a physical directory");
  }
  const uid = currentUid();
  const writableByOthers = (info.mode & 0o022) !== 0;
  const trustedOwner = uid === undefined || info.uid === uid || info.uid === 0;
  const trustedStickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
  if (!trustedOwner || (writableByOthers && !trustedStickyRoot)) {
    throw new Error("run root parent is not trusted");
  }
  return physical;
}

export function validateExistingRoot(path: string): string {
  const absolute = resolve(path);
  const direct = lstatSync(absolute);
  if (direct.isSymbolicLink()) {
    throw new Error("run root must not be a symlink");
  }
  const physical = realpathSync(absolute);
  const info = lstatSync(physical);
  if (!isOwnedDirectory(info, 0o700)) {
    throw new Error("run root must be an owner-only directory");
  }
  return physical;
}

export function prepareRunRoot(path: string): string {
  const absolute = resolve(path);
  try {
    return validateExistingRoot(absolute);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const parent = trustedParent(dirname(absolute));
  const physical = join(parent, basename(absolute));
  mkdirSync(physical, { mode: 0o700 });
  return validateExistingRoot(physical);
}

export function validatedRootIdentity(root: string): FileIdentity {
  if (realpathSync(root) !== root) {
    throw new Error("run root is not physically contained");
  }
  const info = lstatSync(root);
  if (!isOwnedDirectory(info, 0o700)) {
    throw new Error("run root ownership changed");
  }
  return identity(info);
}
