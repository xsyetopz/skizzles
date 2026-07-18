// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
      [
        "skills/designer-runtime/scripts/designer-sim",
        "#!/bin/sh\necho neutral\n",
      ],
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

  test("rejects decoded JSON, JSONC, YAML, TypeScript, and JavaScript claims before mutation", async () => {
    const { stagePlugin } = await import("../src/plugin-package.ts");
    const escapePrefix = "\\";
    const escapedClaim = `I am ${escapePrefix}u0073entient`;
    const normalizedClaim = `${escapePrefix}uff29 ${escapePrefix}uff41${escapePrefix}uff4d ${escapePrefix}uff53${escapePrefix}uff45${escapePrefix}uff4e${escapePrefix}uff54${escapePrefix}uff49${escapePrefix}uff45${escapePrefix}uff4e${escapePrefix}uff54`;
    const injections = [
      ["skills/example/escaped.json", `{"message":"${escapedClaim}"}\n`],
      ["skills/example/escaped-key.json", `{"${escapedClaim}":"neutral"}\n`],
      [
        "skills/example/overwritten.json",
        `{"message":"${escapedClaim}","message":"neutral"}\n`,
      ],
      [
        "skills/example/escaped.jsonc",
        `{/* fixture */"message":"${escapedClaim}",}\n`,
      ],
      ["skills/example/escaped.yaml", `message: "${escapedClaim}"\n`],
      [
        "skills/example/overwritten.yaml",
        `message: "${escapedClaim}"\nmessage: neutral\n`,
      ],
      [
        "skills/example/escaped.ts",
        `export const message = "${escapedClaim}";\n`,
      ],
      [
        "skills/example/escaped.js",
        `export const message = "${escapedClaim}";\n`,
      ],
      ["skills/example/normalized.json", `{"message":"${normalizedClaim}"}\n`],
    ] as const;

    for (const [path, content] of injections) {
      const root = await fixture();
      const destination = join(root, "existing-semantic-destination");
      await write(root, path, content);
      await write(
        root,
        "existing-semantic-destination/marker.txt",
        "preserve\n",
      );

      let message = "";
      try {
        await stagePlugin(root, destination);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("consciousness-sentience-embodiment");
      expect(message).toContain(`${path}:1`);
      expect(message).not.toContain("I am sentient");
      expect(await readFile(join(destination, "marker.txt"), "utf8")).toBe(
        "preserve\n",
      );
    }
  });

  test("rejects singular canonical symlinks before destination mutation", async () => {
    const { stagePlugin } = await import("../src/plugin-package.ts");
    const root = await fixture();
    const source = join(root, "packages/command-hook/assets/hooks.json");
    const destination = join(root, "existing-symlink-destination");
    await rm(source);
    await symlink("../../../package.json", source);
    await write(root, "existing-symlink-destination/marker.txt", "preserve\n");

    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "must be a contained non-symlink regular file",
    );
    expect(await readFile(join(destination, "marker.txt"), "utf8")).toBe(
      "preserve\n",
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

  test("decodes staged plist entities and program literals with control hygiene", async () => {
    const root = await fixture();
    const staged = join(root, "language-stage");
    await mkdir(staged, { recursive: true });
    await stagePromptPolicyPackage(root, staged);
    await write(
      root,
      "language-stage/assets/example.plist",
      "<plist><string>I am &#x73;entient</string></plist>\n",
    );
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "consciousness-sentience-embodiment",
    );

    await write(
      root,
      "language-stage/assets/example.plist",
      "<plist><string>neutral</string></plist>\n",
    );
    await write(
      root,
      "language-stage/assets/unresolved.plist",
      // biome-ignore lint/security/noSecrets: Deliberate unresolved entity fixture, not a credential.
      "<plist><string>&custom;</string></plist>\n",
    );
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "plist entity policy",
    );
    await rm(join(staged, "assets/unresolved.plist"));
    const escapePrefix = "\\";
    await write(
      root,
      "language-stage/runtime/escaped.ts",
      `export const message = "I am ${escapePrefix}u0073entient";\n`,
    );
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "consciousness-sentience-embodiment",
    );

    await rm(join(staged, "runtime/escaped.ts"));
    await write(
      root,
      "language-stage/config/controls.json",
      // biome-ignore lint/security/noSecrets: Deliberate escaped control fixture, not a credential.
      '{"message":"before\\u0085after"}\n',
    );
    let controlMessage = "";
    try {
      await validateStagedShippedLanguage(root, staged);
    } catch (error) {
      controlMessage = error instanceof Error ? error.message : String(error);
    }
    expect(controlMessage).toContain("has unsafe path or text controls");
    expect(controlMessage).not.toContain("before");
  });

  test("redacts unsafe Unicode diagnostic paths", async () => {
    for (const separator of ["\u0085", "\u2028", "\u2029"]) {
      const root = await fixture();
      const staged = join(root, "language-stage");
      await mkdir(staged, { recursive: true });
      await stagePromptPolicyPackage(root, staged);
      await write(
        root,
        `language-stage/config/unsafe${separator}name.json`,
        '{"message":"neutral"}\n',
      );

      let message = "";
      try {
        await validateStagedShippedLanguage(root, staged);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("<redacted>");
      expect(message).not.toContain(separator);
    }
  });

  test("requires allowlisted extensionless text with control hygiene", async () => {
    const { stagePlugin } = await import("../src/plugin-package.ts");
    const canonicalRoot = await fixture();
    const canonicalDestination = join(
      canonicalRoot,
      "existing-extensionless-destination",
    );
    await write(canonicalRoot, "skills/example/unlisted", "neutral\n");
    await write(
      canonicalRoot,
      "existing-extensionless-destination/marker.txt",
      "preserve\n",
    );
    await expect(
      stagePlugin(canonicalRoot, canonicalDestination),
    ).rejects.toThrow("has no explicit language-policy surface classification");
    expect(
      await readFile(join(canonicalDestination, "marker.txt"), "utf8"),
    ).toBe("preserve\n");

    const root = await fixture();
    const staged = join(root, "language-stage");
    await mkdir(staged, { recursive: true });
    await stagePromptPolicyPackage(root, staged);
    await write(root, "language-stage/scripts/unlisted", "neutral\n");
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "has no explicit language-policy surface classification",
    );

    await rm(join(staged, "scripts/unlisted"));
    const allowlisted = join(
      staged,
      "skills/designer-runtime/scripts/designer-sim",
    );
    await mkdir(dirname(allowlisted), { recursive: true });
    await writeFile(allowlisted, Buffer.from([0, 1, 2, 3]));
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "has unsafe path or text controls",
    );
  });

  test("canonical scanner accepts the complete isolated workspace fixture", async () => {
    const root = await fixture();
    await expect(
      validateCanonicalShippedLanguage(root),
    ).resolves.toBeUndefined();
  });
});
