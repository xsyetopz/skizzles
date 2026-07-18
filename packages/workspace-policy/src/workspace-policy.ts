import { relative, resolve } from "node:path";
import { validateWorkspaceImports } from "./import-policy.ts";
import {
  readPackageManifest,
  readWorkspaceManifest,
  validatePackage,
  validateRootManifest,
} from "./package-policy.ts";
import type * as Contract from "./workspace-contract.ts";
import {
  compareFindings,
  type WorkspacePackage,
} from "./workspace-contract.ts";
import {
  discoverPackageRoots,
  validateExpectedPackageNames,
  validateLockfiles,
  validateRootSourceIsolation,
} from "./workspace-files.ts";
import { validateWorkspaceFitness } from "./workspace-fitness.ts";

const PATH_SEPARATOR_PATTERN = /[\\/]/u;

const SKIZZLES_PACKAGE_NAMES = [
  "@skizzles/command-hook",
  "@skizzles/command-supervisor",
  "@skizzles/container-lab",
  "@skizzles/installer",
  "@skizzles/model-catalog",
  "@skizzles/plugin-builder",
  "@skizzles/prompt-layer",
  "@skizzles/usage-analyzer",
  "@skizzles/workspace-policy",
  "codex-fastmcp-template",
] as const;

async function validateWorkspace(
  workspaceRoot: string,
  options: Contract.WorkspacePolicyOptions = {},
): Promise<Contract.WorkspaceFinding[]> {
  return validateWorkspaceMode(workspaceRoot, options, false);
}

async function validateWorkspaceArchitecture(
  workspaceRoot: string,
  options: Contract.WorkspacePolicyOptions = {},
): Promise<Contract.WorkspaceFinding[]> {
  return validateWorkspaceMode(workspaceRoot, options, true);
}

async function validateWorkspaceMode(
  workspaceRoot: string,
  options: Contract.WorkspacePolicyOptions,
  includeArchitectureFitness: boolean,
): Promise<Contract.WorkspaceFinding[]> {
  const root = resolve(workspaceRoot);
  const findings: Contract.WorkspaceFinding[] = [];
  const rootManifest = await readWorkspaceManifest(root, findings);
  if (rootManifest === undefined) {
    return findings;
  }

  validateRootManifest(rootManifest, findings);
  const packageRoots = await discoverPackageRoots(
    root,
    rootManifest.workspaces,
  );
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
  if (includeArchitectureFitness) {
    await validateWorkspaceFitness(packages, findings);
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
} from "./workspace-contract.ts";
export {
  SKIZZLES_PACKAGE_NAMES,
  validateWorkspace,
  validateWorkspaceArchitecture,
};
