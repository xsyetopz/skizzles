import { join } from "node:path";
import type { PromptWorkspace } from "@skizzles/prompt-policy";
import {
  ContainerLabPackageError,
  validateContainerLabDescriptor,
  validateContainerLabRuntime,
} from "../container-lab/composition.ts";
import {
  PromptPolicyPackageError,
  validatePackagedPromptPolicy,
} from "../prompt-policy/composition.ts";
import { PackagingError, PLUGIN_NAME } from "./contract.ts";
import {
  exists,
  readJsonObject,
  rejectForbiddenDistributableContent,
} from "./distribution-files.ts";
import {
  validateHookCommands,
  validateManifest,
  validateMarketplaceEntry,
} from "./manifest.ts";

export async function validateGeneratedPlugin(
  repoRoot: string,
  pluginRoot: string,
  marketplacePath: string,
  workspace: PromptWorkspace,
): Promise<void> {
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifest = await readJsonObject(manifestPath, "plugin manifest");
  const rootPackage = await readJsonObject(
    join(repoRoot, "package.json"),
    "root package.json",
  );

  if (manifest["name"] !== PLUGIN_NAME) {
    throw new PackagingError(`Plugin manifest name must be ${PLUGIN_NAME}.`);
  }
  if (manifest["version"] !== rootPackage["version"]) {
    throw new PackagingError(
      "Plugin manifest and root package versions must match.",
    );
  }
  await validateManifest(manifest, pluginRoot);
  if ("hooks" in manifest) {
    throw new PackagingError(
      "plugin.json intentionally omits `hooks`; keep the canonical default discovery path at hooks/hooks.json.",
    );
  }

  const marketplace = await readJsonObject(
    marketplacePath,
    "marketplace metadata",
  );
  validateMarketplaceEntry(marketplace);

  const hooksPath = join(pluginRoot, "hooks", "hooks.json");
  if (await exists(hooksPath)) {
    const hooks = await readJsonObject(hooksPath, "hooks/hooks.json");
    validateHookCommands(hooks, "hooks/hooks.json");
  }

  await asPackagingError(() => validateContainerLabRuntime(pluginRoot));
  await asPackagingError(() =>
    validateContainerLabDescriptor(repoRoot, pluginRoot),
  );
  await asPackagingError(() =>
    validatePackagedPromptPolicy(repoRoot, pluginRoot, workspace),
  );
  await rejectForbiddenDistributableContent(pluginRoot);
}

async function asPackagingError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof ContainerLabPackageError ||
      error instanceof PromptPolicyPackageError
    ) {
      throw new PackagingError(error.message);
    }
    throw error;
  }
}
