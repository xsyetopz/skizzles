import { lstat, opendir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { digestTaskWorktreeBytes, digestTaskWorktreeValue } from "../digest.ts";
import { readSafeFile } from "../lifecycle/candidate/mutation.ts";
import { isSafeRelativePath } from "../policy/value.ts";
import type { ProtectedManifest, ProtectedManifestEntry } from "./contract.ts";
import type { TaskWorktreeProtectedPathPolicy } from "./public-contract.ts";

export async function captureProtectedManifest(
  root: string,
  policy: Pick<
    TaskWorktreeProtectedPathPolicy,
    "specificationRoots" | "testRoots"
  >,
): Promise<ProtectedManifest | undefined> {
  let canonicalRoot: string;
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    canonicalRoot = await realpath(root);
  } catch {
    return;
  }
  const paths: string[] = [];
  for (const protectedRoot of [
    ...policy.testRoots,
    ...policy.specificationRoots,
  ]) {
    if (!(await collect(canonicalRoot, protectedRoot, paths))) return;
  }
  if (
    [...policy.testRoots, ...policy.specificationRoots].some(
      (protectedRoot) =>
        !paths.some(
          (path) =>
            path === protectedRoot || path.startsWith(`${protectedRoot}/`),
        ),
    )
  )
    return;
  paths.sort((left, right) => (left < right ? -1 : 1));
  const aliases = new Set<string>();
  const entries: ProtectedManifestEntry[] = [];
  for (const path of paths) {
    const alias = path.toLowerCase();
    if (aliases.has(alias)) return;
    aliases.add(alias);
    const file = await readSafeFile(canonicalRoot, path);
    if (file.status !== "present") return;
    entries.push(
      Object.freeze({
        path,
        byteLength: file.bytes.byteLength,
        digest: digestTaskWorktreeBytes(file.bytes),
      }),
    );
  }
  const frozenEntries = Object.freeze(entries);
  const testDigest = categoryDigest(policy.testRoots, frozenEntries);
  const specificationDigest = categoryDigest(
    policy.specificationRoots,
    frozenEntries,
  );
  return Object.freeze({
    entries: frozenEntries,
    testDigest,
    specificationDigest,
    digest: digestTaskWorktreeValue({
      testDigest,
      specificationDigest,
    }),
  });
}

function categoryDigest(
  roots: readonly string[],
  entries: readonly ProtectedManifestEntry[],
): ReturnType<typeof digestTaskWorktreeValue> {
  return digestTaskWorktreeValue({
    roots,
    entries: entries.filter(({ path }) =>
      roots.some((root) => path === root || path.startsWith(`${root}/`)),
    ),
  });
}

async function collect(
  root: string,
  path: string,
  output: string[],
): Promise<boolean> {
  if (!isSafeRelativePath(path)) return false;
  const absolute = join(root, path);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(absolute);
  } catch {
    return false;
  }
  if (metadata.isSymbolicLink()) return false;
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch {
    return false;
  }
  if (!within(root, resolved)) return false;
  if (metadata.isFile()) {
    if (metadata.nlink !== 1) return false;
    output.push(path);
    return true;
  }
  if (!metadata.isDirectory()) return false;
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    directory = await opendir(absolute);
    const names: string[] = [];
    for await (const entry of directory) names.push(entry.name);
    names.sort((left, right) => (left < right ? -1 : 1));
    const aliases = new Set<string>();
    for (const name of names) {
      if (name !== name.normalize("NFC") || name.includes("/") || name === ".")
        return false;
      const alias = name.toLowerCase();
      if (aliases.has(alias)) return false;
      aliases.add(alias);
      if (!(await collect(root, `${path}/${name}`, output))) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (directory !== undefined) {
      try {
        await directory.close();
      } catch {
        // Async directory iteration already closes the handle.
      }
    }
  }
}

function within(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !fromRoot.startsWith("/"))
  );
}
