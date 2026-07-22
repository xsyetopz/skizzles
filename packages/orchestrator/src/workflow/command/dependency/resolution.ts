import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { containedBy, readJson, validPackageName } from "./package-input.ts";

export interface DependencyBoundary {
  readonly root: string;
  readonly workspaces: ReadonlyMap<string, string>;
}

export interface PackageResolution {
  readonly realRoot: string;
  readonly kind: "external" | "workspace";
}

export async function findDependencyBoundary(
  sourceRoot: string,
): Promise<DependencyBoundary | undefined> {
  let current = sourceRoot;
  let standalone: string | undefined;
  while (true) {
    const manifest = await readJson(join(current, "package.json"));
    if (
      manifest !== undefined &&
      (await trustedDirectory(join(current, "node_modules")))
    ) {
      standalone ??= current;
      const patterns = workspacePatterns(manifest["workspaces"]);
      if (patterns !== undefined) {
        const workspaces = await discoverWorkspaces(current, patterns);
        if (workspaces === undefined) return;
        return Object.freeze({ root: current, workspaces });
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (standalone === undefined) return;
  return Object.freeze({ root: standalone, workspaces: new Map() });
}

export async function resolveDependency(
  name: string,
  fromDirectory: string,
  boundary: DependencyBoundary,
): Promise<PackageResolution | undefined> {
  if (!validPackageName(name) || !containedBy(boundary.root, fromDirectory)) {
    return;
  }
  let current = fromDirectory;
  while (containedBy(boundary.root, current)) {
    const resolved = await resolveNodeModulesEntry(name, current, boundary);
    if (resolved !== null) return resolved;
    if (current === boundary.root) break;
    current = dirname(current);
  }
  const workspace = boundary.workspaces.get(name);
  if (workspace === undefined) return;
  return Object.freeze({ realRoot: workspace, kind: "workspace" });
}

async function resolveNodeModulesEntry(
  name: string,
  current: string,
  boundary: DependencyBoundary,
): Promise<PackageResolution | null | undefined> {
  const entry = join(current, "node_modules", ...name.split("/"));
  try {
    const entryStat = await lstat(entry, { bigint: true });
    if (!(entryStat.isDirectory() || entryStat.isSymbolicLink())) return;
    const realRoot = await realpath(entry);
    const realStat = await lstat(realRoot, { bigint: true });
    if (
      !containedBy(boundary.root, realRoot) ||
      !realStat.isDirectory() ||
      realStat.isSymbolicLink() ||
      (await realpath(realRoot)) !== realRoot
    ) {
      return;
    }
    const modulesRoot = join(boundary.root, "node_modules");
    return Object.freeze({
      realRoot,
      kind: containedBy(modulesRoot, realRoot) ? "external" : "workspace",
    });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    return;
  }
}

function workspacePatterns(value: unknown): readonly string[] | undefined {
  const candidate = record(value) ? value["packages"] : value;
  if (!Array.isArray(candidate) || candidate.length === 0) return;
  const patterns: string[] = [];
  for (const pattern of candidate) {
    if (!validWorkspacePattern(pattern)) return;
    patterns.push(pattern);
  }
  return Object.freeze(patterns);
}

function validWorkspacePattern(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || isAbsolute(value)) {
    return false;
  }
  const parts = value.split("/");
  const starCount = parts.filter((part) => part === "*").length;
  return (
    starCount <= 1 &&
    parts.every(
      (part) => part !== "" && part !== "." && part !== ".." && part !== "**",
    )
  );
}

async function discoverWorkspaces(
  root: string,
  patterns: readonly string[],
): Promise<ReadonlyMap<string, string> | undefined> {
  const workspaces = new Map<string, string>();
  for (const pattern of patterns) {
    const candidates = await expandWorkspacePattern(root, pattern);
    if (candidates === undefined) return;
    for (const candidate of candidates) {
      const realRoot = await trustedWorkspaceRoot(root, candidate);
      if (realRoot === undefined) return;
      const manifest = await readJson(join(realRoot, "package.json"));
      const name = manifest?.["name"];
      if (
        typeof name !== "string" ||
        !validPackageName(name) ||
        workspaces.has(name)
      ) {
        return;
      }
      workspaces.set(name, realRoot);
    }
  }
  return workspaces;
}

async function expandWorkspacePattern(
  root: string,
  pattern: string,
): Promise<readonly string[] | undefined> {
  const parts = pattern.split("/");
  const star = parts.indexOf("*");
  if (star === -1) return Object.freeze([join(root, ...parts)]);
  const prefix = join(root, ...parts.slice(0, star));
  const suffix = parts.slice(star + 1);
  try {
    const entries = await readdir(prefix, { withFileTypes: true });
    return Object.freeze(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => join(prefix, entry.name, ...suffix))
        .sort((left, right) => left.localeCompare(right)),
    );
  } catch {
    return;
  }
}

async function trustedWorkspaceRoot(
  boundary: string,
  candidate: string,
): Promise<string | undefined> {
  try {
    const stat = await lstat(candidate, { bigint: true });
    const resolved = await realpath(candidate);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !containedBy(boundary, resolved) ||
      resolved !== candidate
    ) {
      return;
    }
    return resolved;
  } catch {
    return;
  }
}

async function trustedDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path, { bigint: true });
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await realpath(path)) === path
    );
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, expected: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === expected
  );
}
