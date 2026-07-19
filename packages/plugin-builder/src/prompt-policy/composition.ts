import {
  assertContainedRegularFile,
  assertNonSymlinkDirectory,
  copyFixedPolicyFile,
  prepareContainedDestination,
} from "./file-containment.ts";
import { SOURCE_TO_PACKAGE_FILES } from "./layout.ts";
import {
  validatePackagedPromptSurface,
  validatePromptPolicyArtifacts,
  verifyCanonicalPromptLayer,
} from "./validation.ts";

export { PromptPolicyPackageError } from "./layout.ts";

export async function validatePromptPolicySource(
  sourceRoot: string,
): Promise<void> {
  await verifyCanonicalPromptLayer(sourceRoot);
  await validatePromptPolicyArtifacts(sourceRoot, sourceRoot, "source");
}

export async function validatePackagedPromptPolicy(
  sourceRoot: string,
  packageRoot: string,
): Promise<void> {
  await verifyCanonicalPromptLayer(sourceRoot);
  await validatePromptPolicyArtifacts(sourceRoot, packageRoot, "packaged");
  await validatePackagedPromptSurface(packageRoot);
}

export async function stagePromptPolicyPackage(
  sourceRoot: string,
  packageRoot: string,
): Promise<void> {
  await validatePromptPolicySource(sourceRoot);
  await assertNonSymlinkDirectory(packageRoot, "prompt-policy package root");

  for (const [sourcePath, destinationPath] of SOURCE_TO_PACKAGE_FILES) {
    await assertContainedRegularFile(sourceRoot, sourcePath, sourcePath);
    await prepareContainedDestination(packageRoot, destinationPath);
  }
  for (const [sourcePath, destinationPath] of SOURCE_TO_PACKAGE_FILES) {
    await copyFixedPolicyFile(
      sourceRoot,
      sourcePath,
      packageRoot,
      destinationPath,
    );
  }
}
