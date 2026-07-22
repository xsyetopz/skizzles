import { relative, resolve } from "node:path";
import { validateWorkspaceArchitecture } from "./architecture-document.ts";
import type * as Contract from "./contract.ts";
import { compareFindings, type WorkspacePackage } from "./contract.ts";
import {
  discoverPackageRoots,
  validateExpectedPackageNames,
  validateLockfiles,
  validateRootSourceIsolation,
} from "./filesystem.ts";
import { validateWorkspaceFitness } from "./fitness.ts";
import { validateWorkspaceImports } from "./imports.ts";
import {
  readPackageManifest,
  readWorkspaceManifest,
  validatePackage,
  validateRootManifest,
} from "./packages.ts";

const PATH_SEPARATOR_PATTERN = /[\\/]/u;

const SKIZZLES_PACKAGE_NAMES = [
  "@skizzles/candidate-manifest",
  "@skizzles/change-assurance",
  "@skizzles/command-hook",
  "@skizzles/command-supervisor",
  "@skizzles/container-lab",
  "@skizzles/installer",
  "@skizzles/model-catalog",
  "@skizzles/orchestrator",
  "@skizzles/plugin-builder",
  "@skizzles/prompt-layer",
  "@skizzles/reflexion-memory",
  "@skizzles/run-workspace",
  "@skizzles/source-engineering",
  "@skizzles/task-worktree",
  "@skizzles/usage-analyzer",
  "@skizzles/verification-gate",
  "@skizzles/workspace-transaction",
  "@skizzles/workspace-policy",
] as const;

async function validateWorkspace(
  workspaceRoot: string,
  options: Contract.WorkspacePolicyOptions = {},
): Promise<Contract.WorkspaceFinding[]> {
  const root = resolve(workspaceRoot);
  const findings: Contract.WorkspaceFinding[] = [];
  const rootManifest = await readWorkspaceManifest(root, findings);
  if (rootManifest === undefined) {
    return findings;
  }

  validateRootManifest(rootManifest, findings);
  const packageRoots = await discoverPackageRoots(root, findings);
  const packages: WorkspacePackage[] = [];
  const names = new Map<string, string>();
  for (const packageRoot of packageRoots) {
    const relativeRoot = toPortablePath(relative(root, packageRoot));
    const manifest = await readPackageManifest(packageRoot, findings);
    if (manifest === undefined) {
      continue;
    }
    packages.push({ root: packageRoot, relativeRoot, manifest });
    await validatePackage(
      rootManifest,
      relativeRoot,
      packageRoot,
      manifest,
      findings,
    );
    const previous = names.get(manifest.name);
    if (previous === undefined) {
      names.set(manifest.name, relativeRoot);
    } else {
      findings.push({
        code: "duplicate-package-name",
        path: relativeRoot,
        message: `${manifest.name} is already owned by ${previous}`,
      });
    }
  }

  await validateWorkspaceImports(packages, findings);
  await validateWorkspaceFitness(rootManifest, packages, findings);
  if (options.expectedPackageNames !== undefined) {
    await validateWorkspaceArchitecture(root, rootManifest, packages, findings);
  }
  validateExpectedPackageNames(names, options.expectedPackageNames, findings);
  await validateLockfiles(root, findings);
  await validateRootSourceIsolation(root, packageRoots, findings);
  return findings.sort(compareFindings);
}

function toPortablePath(path: string): string {
  return path.split(PATH_SEPARATOR_PATTERN).join("/");
}

export type {
  WorkspaceFinding,
  WorkspacePolicyOptions,
} from "./contract.ts";
export { SKIZZLES_PACKAGE_NAMES, validateWorkspace };
