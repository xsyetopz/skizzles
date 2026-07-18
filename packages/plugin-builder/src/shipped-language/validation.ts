import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ShippedLanguageFinding } from "@skizzles/prompt-layer";
import {
  PROMPT_LAYER_PACKAGE_FILES,
  parseShippedLanguagePolicy,
  SHIPPED_LANGUAGE_POLICY_PATHS,
  validateShippedLanguageText,
} from "@skizzles/prompt-layer";
import {
  CONTAINER_LAB_SOURCE_PATH,
  CONTAINER_LAB_STATIC_INPUTS,
} from "../container-lab-package.ts";
import {
  BUNDLED_ENTRYPOINTS,
  CANONICAL_FILE_INPUTS,
  CANONICAL_TREE_INPUTS,
  PackagingError,
  SKIPPED_WORKSPACE_DIRECTORIES,
  TEMPLATE_PATH,
} from "../plugin/contract.ts";
import { listFiles } from "../plugin/distribution-files.ts";

const TEXT_SURFACE_EXTENSIONS = new Set([
  ".gitignore",
  ".json",
  ".jsonc",
  ".md",
  ".plist",
  ".ts",
  ".yaml",
  ".yml",
]);
const CANONICAL_EXCLUSIONS = new Set([
  SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath,
  "packages/container-lab/LICENSE",
  "packages/plugin-builder/template/assets/logo.png",
  "packages/prompt-layer/assets/upstream/LICENSE",
  "packages/prompt-layer/assets/upstream/NOTICE",
]);
const STAGED_EXCLUSIONS = new Set([
  SHIPPED_LANGUAGE_POLICY_PATHS.packagedPath,
  "assets/logo.png",
  "packages/container-lab/LICENSE",
  "third_party/openai-codex/LICENSE",
  "third_party/openai-codex/NOTICE",
]);

export async function validateCanonicalShippedLanguage(
  repoRoot: string,
): Promise<void> {
  const policyBytes = await readRequired(
    join(repoRoot, SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath),
    SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath,
  );
  const policy = parsePolicy(policyBytes, "canonical shipped-language policy");
  const paths = await canonicalSurfacePaths(repoRoot);
  for (const path of paths) {
    if (CANONICAL_EXCLUSIONS.has(path)) {
      continue;
    }
    assertTextSurface(path, "canonical");
    await validateFile(repoRoot, path, policy);
  }
}

export async function validateStagedShippedLanguage(
  repoRoot: string,
  pluginRoot: string,
): Promise<void> {
  const canonicalBytes = await readRequired(
    join(repoRoot, SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath),
    SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath,
  );
  const stagedBytes = await readRequired(
    join(pluginRoot, SHIPPED_LANGUAGE_POLICY_PATHS.packagedPath),
    SHIPPED_LANGUAGE_POLICY_PATHS.packagedPath,
  );
  const policy = parsePolicy(
    canonicalBytes,
    "canonical shipped-language policy",
  );
  parsePolicy(stagedBytes, "staged shipped-language policy");
  if (!canonicalBytes.equals(stagedBytes)) {
    throw new PackagingError(
      "Staged shipped-language policy diverges from its canonical owner.",
    );
  }

  for (const path of await listFiles(pluginRoot)) {
    if (STAGED_EXCLUSIONS.has(path)) {
      continue;
    }
    assertTextSurface(path, "staged");
    await validateFile(pluginRoot, path, policy);
  }
}

async function canonicalSurfacePaths(repoRoot: string): Promise<string[]> {
  const paths = new Set<string>();
  await addTree(paths, repoRoot, TEMPLATE_PATH);
  for (const [sourcePath] of CANONICAL_TREE_INPUTS) {
    await addTree(paths, repoRoot, sourcePath);
  }
  for (const [sourcePath] of CANONICAL_FILE_INPUTS) {
    paths.add(sourcePath);
  }
  for (const [sourcePath] of PROMPT_LAYER_PACKAGE_FILES) {
    paths.add(sourcePath);
  }
  for (const path of CONTAINER_LAB_STATIC_INPUTS) {
    paths.add(`${CONTAINER_LAB_SOURCE_PATH}/${path}`);
  }

  const runtimePackageRoots = new Set<string>(
    BUNDLED_ENTRYPOINTS.map(({ packageRoot }) => packageRoot),
  );
  runtimePackageRoots.add(CONTAINER_LAB_SOURCE_PATH);
  paths.add("packages/installer/package.json");
  for (const packageRoot of runtimePackageRoots) {
    await addTree(paths, repoRoot, `${packageRoot}/src`);
  }
  return [...paths].sort(compareCodeUnits);
}

async function addTree(
  paths: Set<string>,
  repoRoot: string,
  relativeRoot: string,
): Promise<void> {
  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        SKIPPED_WORKSPACE_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new PackagingError(
          `${relativeRoot}/${relativePath} is an unsupported symlink.`,
        );
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        paths.add(`${relativeRoot}/${relativePath}`);
      } else {
        throw new PackagingError(
          `${relativeRoot}/${relativePath} is not a regular file or directory.`,
        );
      }
    }
  }
  await visit(join(repoRoot, relativeRoot));
}

function assertTextSurface(path: string, mode: "canonical" | "staged"): void {
  if (mode === "canonical") {
    return;
  }
  const name = basename(path);
  const extension = extname(name);
  if (
    (extension === "" && !name.startsWith(".")) ||
    TEXT_SURFACE_EXTENSIONS.has(extension === "" ? name : extension)
  ) {
    return;
  }
  throw new PackagingError(
    `${mode} shipped file ${path} has no explicit language-policy surface classification.`,
  );
}

async function validateFile(
  root: string,
  path: string,
  policy: ReturnType<typeof parseShippedLanguagePolicy>,
): Promise<void> {
  const bytes = await readRequired(join(root, path), path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PackagingError(
      `Shipped language surface ${path} is not valid UTF-8.`,
    );
  }
  let finding: ShippedLanguageFinding | undefined;
  try {
    [finding] = validateShippedLanguageText(policy, text, path);
  } catch {
    throw new PackagingError(
      `Shipped language surface ${path} has an unsafe diagnostic path.`,
    );
  }
  if (finding !== undefined) {
    throw new PackagingError(
      `${finding.path}:${finding.line}: prohibited shipped-language taxonomy ${finding.taxonomyId}.`,
    );
  }
}

async function readRequired(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new PackagingError(
      `Unable to read shipped language surface ${label}.`,
    );
  }
}

function parsePolicy(
  bytes: Uint8Array,
  label: string,
): ReturnType<typeof parseShippedLanguagePolicy> {
  try {
    return parseShippedLanguagePolicy(bytes);
  } catch {
    throw new PackagingError(`${label} failed strict validation.`);
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
