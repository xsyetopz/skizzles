import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stagePromptPolicyPackage } from "../src/prompt-policy-package.ts";
import {
  createTestWorkspace,
  requiredTestRecord,
} from "./plugin-package-fixture.ts";

interface ShippedLanguageTestContext {
  readonly cleanup: () => Promise<void>;
  readonly enableIntendedLogo: (root: string) => Promise<void>;
  readonly fixture: () => Promise<string>;
  readonly mutateJson: (
    path: string,
    mutate: (value: Record<string, unknown>) => void,
  ) => Promise<void>;
  readonly prepareLanguageStage: (
    root: string,
    staged: string,
  ) => Promise<void>;
}

export function createShippedLanguageTestContext(): ShippedLanguageTestContext {
  const workspace = createTestWorkspace();
  const canonicalLogoFixturePath = resolve(
    import.meta.dir,
    "../template/assets/logo.png",
  );

  async function mutateJson(
    path: string,
    mutate: (value: Record<string, unknown>) => void,
  ): Promise<void> {
    const value = requiredTestRecord(
      JSON.parse(await readFile(path, "utf8")),
      path,
    );
    mutate(value);
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function enableIntendedLogo(root: string): Promise<void> {
    const manifestPath = join(
      root,
      "packages/plugin-builder/template/.codex-plugin/plugin.json",
    );
    await mutateJson(manifestPath, (manifest) => {
      const interfaceContract = requiredTestRecord(
        manifest["interface"],
        "plugin interface",
      );
      interfaceContract["logo"] = "./assets/logo.png";
    });
    const logoPath = join(
      root,
      "packages/plugin-builder/template/assets/logo.png",
    );
    await mkdir(dirname(logoPath), { recursive: true });
    await copyFile(canonicalLogoFixturePath, logoPath);
  }

  return {
    cleanup: workspace.cleanup,
    enableIntendedLogo,
    fixture: workspace.fixture,
    mutateJson,
    prepareLanguageStage: stagePromptPolicyPackage,
  };
}
