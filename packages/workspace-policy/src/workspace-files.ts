import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { addFinding, type WorkspaceFinding } from "./workspace-contract.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export async function discoverPackageRoots(
  root: string,
  patterns: readonly string[],
): Promise<string[]> {
  const roots = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      roots.add(resolve(root, pattern));
      continue;
    }
    const parent = resolve(root, pattern.slice(0, -2));
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (await exists(join(parent, entry.name, "package.json")))
      ) {
        roots.add(join(parent, entry.name));
      }
    }
  }
  return [...roots].sort();
}

export async function validateLockfiles(
  root: string,
  findings: WorkspaceFinding[],
): Promise<void> {
  for (const path of await listFiles(root, new Set([".git", "node_modules"]))) {
    if (path.endsWith(`${sep}bun.lock`) && path !== join(root, "bun.lock")) {
      addFinding(
        findings,
        "nested-lockfile",
        toPortablePath(relative(root, path)),
        "only the root bun.lock is allowed",
      );
    }
    if (path.endsWith(".tsbuildinfo")) {
      addFinding(
        findings,
        "build-info",
        toPortablePath(relative(root, path)),
        "TypeScript build info must not be retained",
      );
    }
  }
}

export function validateExpectedPackageNames(
  actual: ReadonlyMap<string, string>,
  expected: readonly string[] | undefined,
  findings: WorkspaceFinding[],
): void {
  if (expected === undefined) {
    return;
  }
  const expectedNames = new Set(expected);
  for (const [name, path] of actual) {
    if (!expectedNames.has(name)) {
      addFinding(
        findings,
        "unexpected-package",
        path,
        `${name} is not part of the workspace architecture`,
      );
    }
  }
  for (const name of expectedNames) {
    if (!actual.has(name)) {
      addFinding(
        findings,
        "missing-package",
        "package.json",
        `workspace is missing ${name}`,
      );
    }
  }
}

export async function validateRootSourceIsolation(
  root: string,
  packageRoots: readonly string[],
  findings: WorkspaceFinding[],
): Promise<void> {
  const excluded = new Set([".git", "dist", "node_modules", "plugins"]);
  for (const path of await listFiles(root, excluded)) {
    if (
      SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) &&
      !packageRoots.some((packageRoot) => inside(packageRoot, path))
    ) {
      addFinding(
        findings,
        "root-source",
        toPortablePath(relative(root, path)),
        "TypeScript production and test sources must be owned by a workspace package",
      );
    }
  }
}

export async function listTypeScriptFiles(root: string): Promise<string[]> {
  return (await listFiles(root, new Set(["dist", "node_modules"]))).filter(
    (path) => SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))),
  );
}

export async function listFiles(
  root: string,
  excluded: ReadonlySet<string>,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return files;
}

function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return (
    offset === "" || !(offset.startsWith(`..${sep}`) || isAbsolute(offset))
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}
