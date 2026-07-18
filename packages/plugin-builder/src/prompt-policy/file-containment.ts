import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MACHINE_PATH_PATTERNS, PromptPolicyPackageError } from "./layout.ts";

interface IntegrityFact {
  sha256: string;
  bytes: number;
}

export async function readValidatedFact(
  root: string,
  fixedPath: string,
  fact: IntegrityFact,
  label: string,
): Promise<Buffer> {
  const bytes = await readFixedPolicyFile(root, fixedPath, label);
  assertDigest(bytes, fact, label);
  return bytes;
}

export async function readFixedPolicyFile(
  root: string,
  fixedPath: string,
  label: string,
): Promise<Buffer> {
  await assertContainedRegularFile(root, fixedPath, label);
  return readFile(join(root, fixedPath));
}

export async function assertContainedRegularFile(
  root: string,
  fixedPath: string,
  label: string,
): Promise<void> {
  await assertNonSymlinkDirectory(root, `${label} root`);
  let current = root;
  for (const segment of fixedPath.split("/")) {
    current = join(current, segment);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch {
      throw new PromptPolicyPackageError(
        `${label} is missing or inaccessible.`,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new PromptPolicyPackageError(
        `${label} uses a symlinked policy path.`,
      );
    }
  }
  const metadata = await lstat(current);
  if (!metadata.isFile()) {
    throw new PromptPolicyPackageError(
      `${label} must be a non-symlink regular file.`,
    );
  }
}

export async function assertNonSymlinkDirectory(
  root: string,
  label: string,
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(root);
  } catch {
    throw new PromptPolicyPackageError(
      `${label} must be a non-symlink directory.`,
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PromptPolicyPackageError(
      `${label} must be a non-symlink directory.`,
    );
  }
}

export async function prepareContainedDestination(
  root: string,
  fixedPath: string,
): Promise<void> {
  await assertNonSymlinkDirectory(root, "prompt-policy package root");
  let current = root;
  for (const segment of dirname(fixedPath).split("/")) {
    current = join(current, segment);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isMissing(error)) {
        throw new PromptPolicyPackageError(
          "Prompt-policy destination is inaccessible.",
        );
      }
      await mkdir(current);
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new PromptPolicyPackageError(
        "Prompt-policy destination uses an unsafe path.",
      );
    }
  }
  try {
    const target = await lstat(join(root, fixedPath));
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new PromptPolicyPackageError(
        "Prompt-policy destination uses an unsafe path.",
      );
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

export async function copyFixedPolicyFile(
  sourceRoot: string,
  sourcePath: string,
  packageRoot: string,
  destinationPath: string,
): Promise<void> {
  const source = join(sourceRoot, sourcePath);
  const destination = join(packageRoot, destinationPath);
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PromptPolicyPackageError(
      `${sourcePath} must be a self-contained regular file.`,
    );
  }
  await copyFile(source, destination);
  await chmod(destination, metadata.mode & 0o777);
}

function assertDigest(bytes: Buffer, fact: IntegrityFact, label: string): void {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== fact.sha256 || bytes.byteLength !== fact.bytes) {
    throw new PromptPolicyPackageError(
      `${label} does not match the prompt-policy integrity facts.`,
    );
  }
}

export function validateCanonicalText(bytes: Buffer, label: string): void {
  if (
    bytes.byteLength === 0 ||
    bytes.includes(0) ||
    bytes.at(-1) !== 0x0a ||
    bytes.includes(Buffer.from("\r"))
  ) {
    throw new PromptPolicyPackageError(`${label} must be canonical LF text.`);
  }
}

export function rejectMachinePath(bytes: Buffer, label: string): void {
  const text = bytes.toString("utf8");
  if (MACHINE_PATH_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new PromptPolicyPackageError(
      `${label} contains a machine-specific path.`,
    );
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
