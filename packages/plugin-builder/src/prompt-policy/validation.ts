import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { checkPrompt, PROMPT_LAYER_SOURCE_PATHS } from "@skizzles/prompt-layer";
import {
  assertPolicyMatchesManifest,
  parseJsonObject,
  parsePromptPolicyContract,
  readPromptManifest,
  validatePromptProvenance,
} from "./contract.ts";
import {
  assertNonSymlinkDirectory,
  readFixedPolicyFile,
  readValidatedFact,
  rejectMachinePath,
  validateCanonicalText,
} from "./file-containment.ts";
import {
  CANONICAL_PROMPT_POLICY_DESCRIPTOR,
  MAINTAINER_PROMPT_PACKAGE_ROOTS,
  PACKAGED_APPLIED_PROMPT,
  PACKAGED_COMPACT_PROMPT,
  PACKAGED_DEVELOPER_INSTRUCTIONS,
  PACKAGED_INSTRUCTION_FILES,
  PACKAGED_LICENSE,
  PACKAGED_NOTICE,
  PACKAGED_OPENAI_LEGAL_FILES,
  PACKAGED_PROMPT_POLICY_DESCRIPTOR,
  PACKAGED_PROMPT_PROVENANCE,
  PROMPT_LAYER_ASSET_ROOT,
  PromptPolicyPackageError,
} from "./layout.ts";

export async function verifyCanonicalPromptLayer(
  sourceRoot: string,
): Promise<void> {
  try {
    await checkPrompt(sourceRoot);
  } catch {
    throw new PromptPolicyPackageError(
      "Canonical prompt-layer verification failed.",
    );
  }
}

export async function validatePackagedPromptSurface(
  packageRoot: string,
): Promise<void> {
  await assertExactFlatDirectory(
    packageRoot,
    "instructions",
    PACKAGED_INSTRUCTION_FILES,
    "packaged prompt instructions",
  );
  await assertExactFlatDirectory(
    packageRoot,
    "third_party/openai-codex",
    PACKAGED_OPENAI_LEGAL_FILES,
    "packaged OpenAI Codex legal directory",
  );
  await inspectPackagedTree(packageRoot);
}

async function assertExactFlatDirectory(
  packageRoot: string,
  relativePath: string,
  expectedNames: readonly string[],
  label: string,
): Promise<void> {
  await assertNonSymlinkDirectory(packageRoot, `${label} package root`);
  const directory = join(packageRoot, relativePath);
  await assertNonSymlinkDirectory(directory, label);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const metadata = await lstat(join(directory, entry.name));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new PromptPolicyPackageError(
        `${label} contains unexpected non-file entry ${entry.name}.`,
      );
    }
  }
  const actualNames = entries.map((entry) => entry.name);
  if (
    actualNames.length !== expectedNames.length ||
    expectedNames.some((name) => !actualNames.includes(name))
  ) {
    throw new PromptPolicyPackageError(
      `${label} must contain exactly ${expectedNames.join(", ")}.`,
    );
  }
}

async function inspectPackagedTree(packageRoot: string): Promise<void> {
  await assertNonSymlinkDirectory(packageRoot, "packaged plugin root");

  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      rejectMaintainerPromptArtifact(relativePath);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new PromptPolicyPackageError(
          `Packaged prompt surface contains symlink ${relativePath}.`,
        );
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (!metadata.isFile()) {
        throw new PromptPolicyPackageError(
          `Packaged prompt surface contains unsupported entry ${relativePath}.`,
        );
      }
    }
  }

  await visit(packageRoot);
}

function rejectMaintainerPromptArtifact(path: string): void {
  const framedPath = `/${path}`;
  const forbiddenRoots = [
    PROMPT_LAYER_ASSET_ROOT,
    ...MAINTAINER_PROMPT_PACKAGE_ROOTS,
  ];
  const forbiddenRoot = forbiddenRoots.find(
    (root) =>
      framedPath.includes(`/${root}/`) || framedPath.endsWith(`/${root}`),
  );
  if (forbiddenRoot !== undefined) {
    throw new PromptPolicyPackageError(
      `Packaged plugin contains maintainer-only prompt-layer artifact ${forbiddenRoot}.`,
    );
  }
}

export async function validatePromptPolicyArtifacts(
  sourceRoot: string,
  artifactRoot: string,
  mode: "source" | "packaged",
): Promise<void> {
  const manifest = await readPromptManifest(sourceRoot);
  const descriptorPath =
    mode === "source"
      ? CANONICAL_PROMPT_POLICY_DESCRIPTOR
      : PACKAGED_PROMPT_POLICY_DESCRIPTOR;
  const descriptorBytes = await readFixedPolicyFile(
    artifactRoot,
    descriptorPath,
    "prompt-policy descriptor",
  );
  validateCanonicalText(descriptorBytes, "prompt-policy descriptor");
  rejectMachinePath(descriptorBytes, "prompt-policy descriptor");
  const descriptor = parseJsonObject(
    descriptorBytes,
    "prompt-policy descriptor",
  );
  const policy = parsePromptPolicyContract(descriptor);
  assertPolicyMatchesManifest(policy, manifest);

  const appliedBytes = await readValidatedFact(
    artifactRoot,
    mode === "source"
      ? PROMPT_LAYER_SOURCE_PATHS.applied
      : PACKAGED_APPLIED_PROMPT,
    policy.applied,
    "applied prompt",
  );
  const provenanceBytes = await readValidatedFact(
    artifactRoot,
    mode === "source"
      ? PROMPT_LAYER_SOURCE_PATHS.provenance
      : PACKAGED_PROMPT_PROVENANCE,
    policy.provenance,
    "prompt provenance",
  );
  const developerBytes = await readValidatedFact(
    artifactRoot,
    mode === "source"
      ? PROMPT_LAYER_SOURCE_PATHS.developer
      : PACKAGED_DEVELOPER_INSTRUCTIONS,
    policy.developer,
    "developer instructions",
  );
  const compactBytes = await readValidatedFact(
    artifactRoot,
    mode === "source"
      ? PROMPT_LAYER_SOURCE_PATHS.compact
      : PACKAGED_COMPACT_PROMPT,
    policy.compact,
    "compact prompt",
  );
  const licensePath =
    mode === "source" ? PROMPT_LAYER_SOURCE_PATHS.license : PACKAGED_LICENSE;
  const noticePath =
    mode === "source" ? PROMPT_LAYER_SOURCE_PATHS.notice : PACKAGED_NOTICE;
  const licenseBytes = await readValidatedFact(
    artifactRoot,
    licensePath,
    policy.license,
    "OpenAI Codex LICENSE",
  );
  const noticeBytes = await readValidatedFact(
    artifactRoot,
    noticePath,
    policy.notice,
    "OpenAI Codex NOTICE",
  );

  for (const [bytes, label] of [
    [appliedBytes, "applied prompt"],
    [provenanceBytes, "prompt provenance"],
    [developerBytes, "developer instructions"],
    [compactBytes, "compact prompt"],
    [licenseBytes, "OpenAI Codex LICENSE"],
    [noticeBytes, "OpenAI Codex NOTICE"],
  ] as const) {
    validateCanonicalText(bytes, label);
    rejectMachinePath(bytes, label);
  }

  const provenance = parseJsonObject(provenanceBytes, "prompt provenance");
  validatePromptProvenance(provenance, policy, manifest);
}
