import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { privateDirectory, sameIdentity } from "../identity.ts";
import { verifyOwnedFile } from "./file-io.ts";
import {
  pathInRoot,
  type StagedDirectory,
  type StagedFile,
  type StagedLink,
} from "./state.ts";

export async function verifyStagedTree(
  root: string,
  files: readonly StagedFile[],
  directories: readonly StagedDirectory[],
  links: readonly StagedLink[],
): Promise<boolean> {
  if (!(await exactDirectoryEntries(root, files, directories, links))) {
    return false;
  }
  for (const directory of directories) {
    const stat = await lstat(join(root, directory.path), { bigint: true });
    if (!(privateDirectory(stat) && sameIdentity(stat, directory.identity))) {
      return false;
    }
  }
  for (const file of files) {
    if (!(await verifyOwnedFile(join(root, file.path), file))) return false;
  }
  for (const link of links) {
    if (!(await verifyLink(root, link))) return false;
  }
  return true;
}

async function exactDirectoryEntries(
  root: string,
  files: readonly StagedFile[],
  directories: readonly StagedDirectory[],
  links: readonly StagedLink[],
): Promise<boolean> {
  const expected = new Map<string, Set<string>>();
  expected.set("", new Set());
  for (const directory of directories) {
    if (!addExpectedEntry(expected, directory.path)) return false;
    expected.set(directory.path, new Set());
  }
  for (const file of files) {
    if (!addExpectedEntry(expected, file.path)) return false;
  }
  for (const link of links) {
    if (!addExpectedEntry(expected, link.path)) return false;
  }
  for (const [path, names] of expected) {
    const actual = (await readdir(pathInRoot(root, path))).sort((left, right) =>
      left.localeCompare(right),
    );
    const wanted = [...names].sort((left, right) => left.localeCompare(right));
    if (
      actual.length !== wanted.length ||
      actual.some((name, index) => name !== wanted[index])
    ) {
      return false;
    }
  }
  return true;
}

function addExpectedEntry(
  expected: Map<string, Set<string>>,
  path: string,
): boolean {
  const parent = posix.dirname(path);
  const parentPath = parent === "." ? "" : parent;
  const names = expected.get(parentPath);
  if (names === undefined) return false;
  names.add(posix.basename(path));
  return true;
}

async function verifyLink(
  root: string,
  expected: StagedLink,
): Promise<boolean> {
  const path = join(root, expected.path);
  const stat = await lstat(path, { bigint: true });
  if (
    !(
      stat.isSymbolicLink() &&
      stat.nlink === 1n &&
      sameIdentity(stat, expected.identity)
    ) ||
    (await readlink(path)) !== expected.target
  ) {
    return false;
  }
  const rootReal = await realpath(root);
  const resolvedPath = await realpath(path);
  return (
    (resolvedPath === rootReal ||
      resolvedPath.startsWith(`${rootReal}${sep}`)) &&
    resolvedPath === expected.resolvedPath
  );
}
