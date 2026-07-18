import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
} from "../container-lab-package.ts";
import {
  PromptPolicyPackageError,
  stagePromptPolicyPackage,
  validatePromptPolicySource,
} from "../prompt-policy-package.ts";
import {
  validateCanonicalShippedLanguage,
  validateStagedShippedLanguage,
} from "../shipped-language/validation.ts";
import { SkillMetadataError } from "../skill-metadata/contract.ts";
import {
  validateCanonicalSkillMetadata,
  validateStagedSkillMetadata,
} from "../skill-metadata/validation.ts";
import {
  CANONICAL_FILE_INPUTS,
  CANONICAL_TREE_INPUTS,
  GENERATED_PATH,
  MARKETPLACE_PATH,
  PackagingError,
  PLUGIN_NAME,
  TEMPLATE_PATH,
} from "./contract.ts";
import { replaceDirectoryTransaction } from "./destination-transaction.ts";
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
  const paths = packagePaths(repoRoot);
  await replaceDirectoryTransaction(destination, (privateRoot) =>
    constructPlugin(paths, privateRoot),
  );
}

async function constructPlugin(
  paths: PackagePaths,
  destination: string,
): Promise<void> {
  await validateCanonicalShippedLanguage(paths.repoRoot);
  await asPackagingError(() => validateCanonicalAgentContracts(paths.repoRoot));
  await asPackagingError(() => validateCanonicalSkillMetadata(paths.repoRoot));
  await asPackagingError(() => validatePromptPolicySource(paths.repoRoot));
  await copyCanonicalTree(paths.templateRoot, destination, "plugin template");

  for (const [sourcePath, destinationPath] of CANONICAL_TREE_INPUTS) {
    const source = join(paths.repoRoot, sourcePath);
    // biome-ignore lint/performance/noAwaitInLoops: canonical inputs are copied in declared order for deterministic failures.
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
    // biome-ignore lint/performance/noAwaitInLoops: canonical inputs are copied in declared order for deterministic failures.
    await copyCanonicalFile(
      join(paths.repoRoot, sourcePath),
      join(destination, destinationPath),
      sourcePath,
    );
  }

  await bundleCanonicalEntrypoints(paths.repoRoot, destination);
  await validatePackagedInstaller(paths.repoRoot, destination);

  await asPackagingError(() =>
    stagePromptPolicyPackage(paths.repoRoot, destination),
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
  );
  await validateStagedShippedLanguage(paths.repoRoot, destination);
}

export async function buildPlugin(repoRoot = defaultRepoRoot()): Promise<void> {
  const paths = packagePaths(repoRoot);
  await stagePlugin(paths.repoRoot, paths.generatedRoot);
}

export async function checkPlugin(repoRoot = defaultRepoRoot()): Promise<void> {
  const paths = packagePaths(repoRoot);
  const comparisonParent = await mkdtemp(
    join(tmpdir(), `${PLUGIN_NAME}-package-check-`),
  );
  const comparisonRoot = join(comparisonParent, PLUGIN_NAME);

  try {
    await stagePlugin(paths.repoRoot, comparisonRoot);
    await rejectFinderMetadata(paths.generatedRoot, "generated plugin");
    const drift = await compareTrees(comparisonRoot, paths.generatedRoot);
    if (drift.length > 0) {
      throw new PackagingError(
        `Generated plugin diverges from canonical sources:\n${drift
          .map((line) => `- ${line}`)
          .join("\n")}\nRun \`bun run plugin:build\`.`,
      );
    }
  } finally {
    await rm(comparisonParent, { force: true, recursive: true });
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
