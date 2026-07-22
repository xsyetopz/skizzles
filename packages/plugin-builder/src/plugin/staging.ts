import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentContractPackageError } from "../agent-contract/contract.ts";
import {
  validateCanonicalAgentContracts,
  validateStagedAgentContracts,
} from "../agent-contract/validation.ts";
import {
  ContainerLabPackageError,
  stageContainerLabRuntime,
} from "../container-lab/composition.ts";
import {
  PromptPolicyPackageError,
  stagePromptPolicyPackage,
  validatePromptPolicySource,
} from "../prompt-policy/composition.ts";
import {
  validateCanonicalShippedLanguage,
  validateStagedShippedLanguage,
} from "../shipped-language/validation.ts";
import { SkillMetadataError } from "../skill-metadata/contract.ts";
import {
  validateCanonicalSkillMetadata,
  validateStagedSkillMetadata,
} from "../skill-metadata/validation/metadata.ts";
import {
  CANONICAL_FILE_INPUTS,
  CANONICAL_TREE_INPUTS,
  GENERATED_PATH,
  MARKETPLACE_PATH,
  PackagingError,
  PLUGIN_NAME,
  TEMPLATE_PATH,
} from "./contract.ts";
import { replaceDirectoryTransaction } from "./destination/transaction.ts";
import {
  copyCanonicalFile,
  copyCanonicalTree,
  exists,
  rejectFinderMetadata,
} from "./distribution-files.ts";
import {
  bundleCanonicalEntrypoints,
  validatePackagedInstaller,
} from "./runtime-bundles.ts";
import { compareTrees } from "./tree-comparison.ts";
import { validateGeneratedPlugin } from "./validation.ts";
import { type PluginWorkspace, withPluginWorkspace } from "./workspace.ts";

export interface PackagePaths {
  repoRoot: string;
  templateRoot: string;
  generatedRoot: string;
  marketplacePath: string;
}

export function packagePaths(repoRoot = defaultRepoRoot()): PackagePaths {
  const absoluteRoot = resolve(repoRoot);
  return {
    repoRoot: absoluteRoot,
    templateRoot: join(absoluteRoot, TEMPLATE_PATH),
    generatedRoot: join(absoluteRoot, GENERATED_PATH),
    marketplacePath: join(absoluteRoot, MARKETPLACE_PATH),
  };
}

export async function stagePlugin(
  repoRoot: string,
  destination: string,
): Promise<void> {
  await withPluginWorkspace((workspace) =>
    stagePluginWithWorkspace(repoRoot, destination, workspace),
  );
}

export async function stagePluginWithWorkspace(
  repoRoot: string,
  destination: string,
  workspace: PluginWorkspace,
): Promise<void> {
  const paths = packagePaths(repoRoot);
  await replaceDirectoryTransaction(destination, (privateRoot) =>
    constructPlugin(paths, privateRoot, workspace),
  );
}

async function constructPlugin(
  paths: PackagePaths,
  destination: string,
  workspace: PluginWorkspace,
): Promise<void> {
  await validateCanonicalShippedLanguage(paths.repoRoot);
  await asPackagingError(() => validateCanonicalAgentContracts(paths.repoRoot));
  await asPackagingError(() => validateCanonicalSkillMetadata(paths.repoRoot));
  await asPackagingError(() =>
    validatePromptPolicySource(paths.repoRoot, workspace.prompt),
  );
  await copyCanonicalTree(paths.templateRoot, destination, "plugin template");

  for (const [sourcePath, destinationPath] of CANONICAL_TREE_INPUTS) {
    const source = join(paths.repoRoot, sourcePath);

    const sourceExists = await exists(source);
    if (sourceExists) {
      await copyCanonicalTree(
        source,
        join(destination, destinationPath),
        sourcePath,
      );
    }
  }

  for (const [sourcePath, destinationPath] of CANONICAL_FILE_INPUTS) {
    await copyCanonicalFile(
      join(paths.repoRoot, sourcePath),
      join(destination, destinationPath),
      sourcePath,
    );
  }

  await bundleCanonicalEntrypoints(paths.repoRoot, destination);
  await validatePackagedInstaller(paths.repoRoot, destination, workspace);

  await asPackagingError(() =>
    stagePromptPolicyPackage(paths.repoRoot, destination, workspace.prompt),
  );

  await asPackagingError(() =>
    stageContainerLabRuntime(paths.repoRoot, destination),
  );

  await asPackagingError(() =>
    validateStagedAgentContracts(paths.repoRoot, destination),
  );
  await asPackagingError(() =>
    validateStagedSkillMetadata(paths.repoRoot, destination),
  );

  await validateGeneratedPlugin(
    paths.repoRoot,
    destination,
    paths.marketplacePath,
    workspace.prompt,
  );
  await validateStagedShippedLanguage(paths.repoRoot, destination);
}

export async function buildPlugin(repoRoot = defaultRepoRoot()): Promise<void> {
  await withPluginWorkspace(async (workspace) => {
    const paths = packagePaths(repoRoot);
    await stagePluginWithWorkspace(
      paths.repoRoot,
      paths.generatedRoot,
      workspace,
    );
  });
}

export async function checkPlugin(repoRoot = defaultRepoRoot()): Promise<void> {
  await withPluginWorkspace((workspace) =>
    checkPluginWithWorkspace(repoRoot, workspace),
  );
}

export async function checkPluginWithWorkspace(
  repoRoot: string,
  workspace: PluginWorkspace,
): Promise<void> {
  const paths = packagePaths(repoRoot);
  const comparisonRoot = workspace.path("comparison", PLUGIN_NAME);
  await stagePluginWithWorkspace(paths.repoRoot, comparisonRoot, workspace);
  await rejectFinderMetadata(paths.generatedRoot, "generated plugin");
  const drift = await compareTrees(comparisonRoot, paths.generatedRoot);
  if (drift.length > 0) {
    throw new PackagingError(
      `Generated plugin diverges from canonical sources:\n${drift
        .map((line) => `- ${line}`)
        .join("\n")}\nRun \`bun run plugin:build\`.`,
    );
  }
}

function defaultRepoRoot(): string {
  let candidate = dirname(fileURLToPath(import.meta.url));
  while (!isSkizzlesWorkspace(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new PackagingError("Unable to locate the Skizzles workspace root.");
    }
    candidate = parent;
  }
  return candidate;
}

function isSkizzlesWorkspace(candidate: string): boolean {
  if (!existsSync(join(candidate, TEMPLATE_PATH))) {
    return false;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(join(candidate, "package.json"), "utf8"),
    );
  } catch {
    return false;
  }
  if (!isObject(manifest)) {
    return false;
  }
  return (
    manifest["name"] === "skizzles" &&
    Array.isArray(manifest["workspaces"]) &&
    manifest["workspaces"].includes("packages/*")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function asPackagingError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof AgentContractPackageError ||
      error instanceof ContainerLabPackageError ||
      error instanceof PromptPolicyPackageError ||
      error instanceof SkillMetadataError
    ) {
      throw new PackagingError(error.message);
    }
    throw error;
  }
}
