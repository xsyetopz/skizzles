import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { PackagingError } from "../plugin/contract.ts";

const MAX_LANGUAGE_SURFACE_BYTES = 16 * 1024 * 1024;
const FORMAT_CONTROL_PATTERN = /\p{Cf}/u;

export class LanguageSurfaceBoundaryError extends PackagingError {}

export async function readContainedLanguageSurface(
  root: string,
  relativePath: string,
): Promise<Buffer> {
  validateRelativePath(relativePath);
  const resolvedRoot = await resolveDirectory(root);
  const path = resolve(resolvedRoot, relativePath);
  if (!isContained(resolvedRoot, path)) {
    throw boundaryError(relativePath);
  }

  const components = relativePath.split("/");
  let current = resolvedRoot;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const metadata = await inspectPath(current, relativePath);
    if (metadata.isSymbolicLink()) {
      throw boundaryError(relativePath);
    }
    const isTarget = index === components.length - 1;
    if (isTarget ? !metadata.isFile() : !metadata.isDirectory()) {
      throw boundaryError(relativePath);
    }
  }

  const before = await inspectPath(path, relativePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw boundaryError(relativePath);
  }
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, flags);
  } catch {
    throw boundaryError(relativePath);
  }
  try {
    const opened = await handle.stat();
    const after = await inspectPath(path, relativePath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      before.nlink !== 1 ||
      opened.nlink !== 1 ||
      after.nlink !== 1
    ) {
      throw boundaryError(relativePath);
    }
    if (
      !Number.isSafeInteger(opened.size) ||
      opened.size < 0 ||
      opened.size > MAX_LANGUAGE_SURFACE_BYTES
    ) {
      throw byteBoundsError(relativePath);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        throw boundaryError(relativePath);
      }
      offset += result.bytesRead;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    const growth = await handle.read(growthProbe, 0, 1, bytes.byteLength);
    const completed = await handle.stat();
    const completedPath = await inspectPath(path, relativePath);
    if (
      growth.bytesRead !== 0 ||
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.nlink !== 1 ||
      completed.size !== opened.size ||
      completedPath.isSymbolicLink() ||
      !completedPath.isFile() ||
      completedPath.dev !== opened.dev ||
      completedPath.ino !== opened.ino ||
      completedPath.nlink !== 1 ||
      completedPath.size !== opened.size
    ) {
      throw boundaryError(relativePath);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function resolveDirectory(root: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(resolve(root));
  } catch {
    throw new PackagingError(
      "Shipped-language surface root is missing or inaccessible.",
    );
  }
  const metadata = await inspectPath(resolved, "surface root");
  if (!metadata.isDirectory()) {
    throw new PackagingError(
      "Shipped-language surface root is not a directory.",
    );
  }
  return resolved;
}

async function inspectPath(
  path: string,
  relativePath: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path);
  } catch {
    throw boundaryError(relativePath);
  }
}

function validateRelativePath(path: string): void {
  const components = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    safeLanguageDiagnosticPath(path) === "<redacted>" ||
    components.some(
      (component) =>
        component.length === 0 || component === "." || component === "..",
    )
  ) {
    throw boundaryError(path);
  }
}

function isContained(root: string, path: string): boolean {
  const relation = relative(root, path);
  return !(
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    relation.startsWith(sep)
  );
}

function boundaryError(path: string): LanguageSurfaceBoundaryError {
  return new LanguageSurfaceBoundaryError(
    `Shipped-language surface ${safeLanguageDiagnosticPath(path)} must be a contained non-symlink regular file.`,
  );
}

function byteBoundsError(path: string): LanguageSurfaceBoundaryError {
  return new LanguageSurfaceBoundaryError(
    `Shipped-language surface ${safeLanguageDiagnosticPath(path)} exceeds its bounded byte length.`,
  );
}

export function safeLanguageDiagnosticPath(path: string): string {
  if (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === "..") &&
    [...path].every((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        codePoint >= 32 &&
        !(codePoint >= 127 && codePoint <= 159) &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff) &&
        codePoint !== 0x2028 &&
        codePoint !== 0x2029 &&
        !FORMAT_CONTROL_PATTERN.test(character)
      );
    })
  ) {
    return path;
  }
  return "<redacted>";
}
