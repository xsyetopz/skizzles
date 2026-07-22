import { join } from "node:path";
import type {
  RunWorkspace,
  WorkspaceUsageLimits,
} from "@skizzles/run-workspace";
import type { Digest } from "../../../digest.ts";
import type { OwnedIdentity } from "../identity.ts";

export interface StagedFile {
  readonly path: string;
  readonly identity: OwnedIdentity;
  readonly bytes: number;
  readonly digest: Digest;
}

export interface StagedDirectory {
  readonly path: string;
  readonly identity: OwnedIdentity;
}

export interface StagedLink {
  readonly path: string;
  readonly identity: OwnedIdentity;
  readonly target: string;
  readonly resolvedPath: string;
}

export interface MutableStage {
  readonly files: Map<string, StagedFile>;
  readonly directories: Map<string, StagedDirectory>;
  readonly links: Map<string, StagedLink>;
}

export function createMutableStage(): MutableStage {
  return {
    files: new Map(),
    directories: new Map(),
    links: new Map(),
  };
}

export function pathInRoot(root: string, relativePath: string): string {
  if (relativePath === "") return root;
  return join(root, relativePath);
}

export function validRelativePath(path: string): boolean {
  const parts = path.split("/");
  return parts.length > 0 && parts.every(validPart);
}

export function sortByPath<T extends { readonly path: string }>(
  values: Iterable<T>,
): T[] {
  return [...values].sort((left, right) => left.path.localeCompare(right.path));
}

export async function withinQuota(
  workspace: RunWorkspace,
  limits: WorkspaceUsageLimits,
): Promise<boolean> {
  const usage = await workspace.inspectUsage(limits);
  if (usage.state === "within") return true;
  if (usage.state === "exceeded") return false;
  const revalidated = await workspace.inspectUsage(limits);
  return revalidated.state === "within";
}

function validPart(part: string): boolean {
  return part !== "" && part !== "." && part !== "..";
}
