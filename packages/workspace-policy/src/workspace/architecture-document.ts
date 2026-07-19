import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addFinding,
  type WorkspaceFinding,
  type WorkspaceManifest,
  type WorkspacePackage,
} from "./contract.ts";

const ARCHITECTURE_DOCUMENT_PATH = "docs/workspace-architecture.md";
const EDGE_BLOCK_START = "<!-- workspace-policy:dependency-edges:start -->";
const EDGE_BLOCK_END = "<!-- workspace-policy:dependency-edges:end -->";
const EDGE_BLOCK_PATTERN = /^\n```text\n(?<edges>[\s\S]*?)\n```\n$/u;
const EDGE_LINE_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]* -> (?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const CONTRACT_MESSAGE =
  "dependency edges must use one marked text fence with sorted unique package edges";
const DRIFT_MESSAGE =
  "documented dependency edges must exactly match workspace manifests";

async function validateWorkspaceArchitecture(
  workspaceRoot: string,
  rootManifest: WorkspaceManifest,
  packages: readonly WorkspacePackage[],
  findings: WorkspaceFinding[],
): Promise<void> {
  let document: string;
  try {
    document = await readFile(
      join(workspaceRoot, ARCHITECTURE_DOCUMENT_PATH),
      "utf8",
    );
  } catch {
    addFinding(
      findings,
      "workspace-architecture-contract",
      ARCHITECTURE_DOCUMENT_PATH,
      CONTRACT_MESSAGE,
    );
    return;
  }
  validateWorkspaceArchitectureDocument(
    document,
    rootManifest,
    packages,
    findings,
  );
}

function validateWorkspaceArchitectureDocument(
  document: string,
  rootManifest: WorkspaceManifest,
  packages: readonly WorkspacePackage[],
  findings: WorkspaceFinding[],
): void {
  const documented = documentedDependencyEdges(document);
  if (documented === undefined) {
    addFinding(
      findings,
      "workspace-architecture-contract",
      ARCHITECTURE_DOCUMENT_PATH,
      CONTRACT_MESSAGE,
    );
    return;
  }
  const expected = workspaceDependencyEdges(rootManifest, packages);
  if (!sameStrings(documented, expected)) {
    addFinding(
      findings,
      "workspace-architecture-dependency-drift",
      ARCHITECTURE_DOCUMENT_PATH,
      DRIFT_MESSAGE,
    );
  }
}

function documentedDependencyEdges(
  document: string,
): readonly string[] | undefined {
  const start = document.indexOf(EDGE_BLOCK_START);
  const end = document.indexOf(EDGE_BLOCK_END);
  if (
    start < 0 ||
    end < start ||
    start !== document.lastIndexOf(EDGE_BLOCK_START) ||
    end !== document.lastIndexOf(EDGE_BLOCK_END)
  ) {
    return;
  }
  const body = document.slice(start + EDGE_BLOCK_START.length, end);
  const match = EDGE_BLOCK_PATTERN.exec(body);
  if (match === null) {
    return;
  }
  const content = match.groups?.["edges"];
  if (content === undefined || content.length === 0) {
    return [];
  }
  const edges = content.split("\n");
  const sorted = [...new Set(edges)].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  if (
    edges.some((edge) => !EDGE_LINE_PATTERN.test(edge)) ||
    !sameStrings(edges, sorted)
  ) {
    return;
  }
  return edges;
}

function workspaceDependencyEdges(
  rootManifest: WorkspaceManifest,
  packages: readonly WorkspacePackage[],
): readonly string[] {
  const packageNames = new Set(packages.map(({ manifest }) => manifest.name));
  const consumers = [rootManifest, ...packages.map(({ manifest }) => manifest)];
  const edges = new Set<string>();
  for (const consumer of consumers) {
    for (const dependencies of dependencyMaps(consumer)) {
      for (const dependency of Object.keys(dependencies)) {
        if (packageNames.has(dependency)) {
          edges.add(`${consumer.name} -> ${dependency}`);
        }
      }
    }
  }
  return [...edges].sort((left, right) => left.localeCompare(right, "en"));
}

function dependencyMaps(
  manifest: WorkspaceManifest | WorkspacePackage["manifest"],
): readonly Record<string, string>[] {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export {
  EDGE_BLOCK_END,
  EDGE_BLOCK_START,
  validateWorkspaceArchitecture,
  validateWorkspaceArchitectureDocument,
  workspaceDependencyEdges,
};
