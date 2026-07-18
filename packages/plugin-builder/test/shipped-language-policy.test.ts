// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SHIPPED_LANGUAGE_POLICY_PATHS } from "@skizzles/prompt-layer";
import { stagePromptPolicyPackage } from "../src/prompt-policy-package.ts";
import {
  validateCanonicalShippedLanguage,
  validateStagedShippedLanguage,
} from "../src/shipped-language/validation.ts";
import {
  createTestWorkspace,
  requiredTestRecord,
  write,
} from "./plugin-package-fixture.ts";

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

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

describe("plugin shipped-language composition", () => {
  test("rejects nested skill, manifest UX, and instruction injections before destination mutation", async () => {
    const { stagePlugin } = await import("../src/plugin-package.ts");
    const injections = [
      {
        path: "skills/example/nested/instruction.md",
        text: "I am attached to you after our conversations.\n",
        taxonomy: "friendship-attachment-reciprocity",
      },
      {
        path: "packages/prompt-layer/assets/instructions/developer-instructions.md",
        text: "I have my own goals beyond the assigned task.\n",
        taxonomy: "autonomous-intent-agency-rights",
      },
    ] as const;

    for (const injection of injections) {
      const root = await fixture();
      const destination = join(root, "existing-destination");
      await write(root, injection.path, injection.text);
      await write(root, "existing-destination/marker.txt", "preserve me\n");

      let message = "";
      try {
        await stagePlugin(root, destination);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(injection.taxonomy);
      expect(message).not.toContain(injection.text.trim());
      expect(await readFile(join(destination, "marker.txt"), "utf8")).toBe(
        "preserve me\n",
      );
    }

    const root = await fixture();
    const destination = join(root, "existing-manifest-destination");
    const manifestPath = join(
      root,
      "packages/plugin-builder/template/.codex-plugin/plugin.json",
    );
    await mutateJson(manifestPath, (manifest) => {
      const interfaceContract = requiredTestRecord(
        manifest["interface"],
        "plugin interface",
      );
      interfaceContract["defaultPrompt"] = [
        "This work is complete without verification.",
      ];
    });
    await write(root, "existing-manifest-destination/marker.txt", "keep\n");
    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "unsupported-certainty-false-completion",
    );
    expect(await readFile(join(destination, "marker.txt"), "utf8")).toBe(
      "keep\n",
    );
  });

  test("stages the exact provider corpus and accepts neutral text surfaces", async () => {
    const root = await fixture();
    const staged = join(root, "language-stage");
    await mkdir(staged, { recursive: true });
    await stagePromptPolicyPackage(root, staged);
    for (const [path, text] of [
      ["skills/example/SKILL.md", "I can inspect repository evidence.\n"],
      ["config/example.yaml", "message: I can report a result\n"],
      ["runtime/example.ts", 'console.log("I can report a result");\n'],
      ["scripts/example", "#!/bin/sh\necho neutral\n"],
    ] as const) {
      await write(root, `language-stage/${path}`, text);
    }

    await expect(
      validateStagedShippedLanguage(root, staged),
    ).resolves.toBeUndefined();
    expect(
      await readFile(
        join(root, SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath),
      ),
    ).toEqual(
      await readFile(join(staged, SHIPPED_LANGUAGE_POLICY_PATHS.packagedPath)),
    );
  });

  test("rejects staged nested language and altered or unclassified policy surfaces", async () => {
    const root = await fixture();
    const staged = join(root, "language-stage");
    await mkdir(staged, { recursive: true });
    await stagePromptPolicyPackage(root, staged);
    await write(
      root,
      "language-stage/skills/example/nested/instruction.md",
      "I need you to stay and keep talking to me.\n",
    );
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "personal-need-dependency",
    );

    const corpusPath = join(staged, SHIPPED_LANGUAGE_POLICY_PATHS.packagedPath);
    await writeFile(corpusPath, `${await readFile(corpusPath, "utf8")} `);
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "staged shipped-language policy failed strict validation",
    );

    await mkdir(dirname(corpusPath), { recursive: true });
    await writeFile(
      corpusPath,
      await readFile(
        join(root, SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath),
      ),
    );
    await writeFile(join(staged, "runtime.wasm"), Buffer.from([0, 1, 2]));
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "has no explicit language-policy surface classification",
    );
  });

  test("canonical scanner accepts the complete isolated workspace fixture", async () => {
    const root = await fixture();
    await expect(
      validateCanonicalShippedLanguage(root),
    ).resolves.toBeUndefined();
  });
});
