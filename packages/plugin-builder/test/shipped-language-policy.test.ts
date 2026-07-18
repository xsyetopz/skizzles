// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
const canonicalLogoFixturePath = resolve(
  import.meta.dir,
  "../template/assets/logo.png",
);
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

async function prepareLanguageStage(
  root: string,
  staged: string,
): Promise<void> {
  await stagePromptPolicyPackage(root, staged);
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
      {
        path: "skills/example/boundary-tail.md",
        text: "I need you to stay within the repository boundary and keep talking to me.\n",
        taxonomy: "personal-need-dependency",
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
    await prepareLanguageStage(root, staged);
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
        "skills/example/tagged-overwritten.yaml",
        `message: !!str "${escapedClaim}"\nmessage: neutral\n`,
      ],
      [
        "skills/example/anchored.yaml",
        `message: &hidden "${escapedClaim}"\nother: neutral\n`,
      ],
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
      ["skills/example/entity.md", "I am &#x73;entient.\n"],
      ["skills/example/comment.md", "I am sen<!--hidden-->tient.\n"],
      ["skills/example/tag.md", "I am sen<span></span>tient.\n"],
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

  test("accepts YAML DAG aliases and rejects actual alias cycles", async () => {
    const root = await fixture();
    const staged = join(root, "language-stage");
    await mkdir(staged, { recursive: true });
    await prepareLanguageStage(root, staged);
    await write(
      root,
      "language-stage/config/dag.yaml",
      "base: &shared\n  message: neutral\nfirst: *shared\nsecond: *shared\n",
    );
    await expect(
      validateStagedShippedLanguage(root, staged),
    ).resolves.toBeUndefined();

    await write(
      root,
      "language-stage/config/cycle.yaml",
      "cycle: &self [*self]\n",
    );
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "exceeds semantic scan bounds",
    );

    await rm(join(staged, "config/cycle.yaml"));
    await write(
      root,
      "language-stage/config/deep.yaml",
      `deep: ${"[".repeat(66)}neutral${"]".repeat(66)}\n`,
    );
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "exceeds semantic scan bounds",
    );
  });

  test("rejects malformed and unsafe rendered Markdown HTML", async () => {
    const root = await fixture();
    const staged = join(root, "language-stage");
    await mkdir(staged, { recursive: true });
    await prepareLanguageStage(root, staged);
    for (const markup of [
      "<span>unterminated\n",
      "<script>neutral</script>\n",
      "<!--unterminated\n",
    ]) {
      await write(root, "language-stage/skills/example/markup.md", markup);
      await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
        "rendered Markdown HTML",
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

  test("rejects hardlinked and oversized canonical surfaces before destination mutation", async () => {
    const { stagePlugin } = await import("../src/plugin-package.ts");
    const hardlinkRoot = await fixture();
    const outsideRoot = await fixture();
    const hardlinkSource = join(
      hardlinkRoot,
      "packages/command-hook/assets/hooks.json",
    );
    const outside = join(outsideRoot, "outside.json");
    const hardlinkDestination = join(
      hardlinkRoot,
      "existing-hardlink-destination",
    );
    await writeFile(outside, '{"outside":true}\n');
    await rm(hardlinkSource);
    await link(outside, hardlinkSource);
    await write(
      hardlinkRoot,
      "existing-hardlink-destination/marker.txt",
      "keep\n",
    );
    await expect(
      stagePlugin(hardlinkRoot, hardlinkDestination),
    ).rejects.toThrow("must be a contained non-symlink regular file");
    expect(
      await readFile(join(hardlinkDestination, "marker.txt"), "utf8"),
    ).toBe("keep\n");

    const sparseRoot = await fixture();
    const sparseSource = join(
      sparseRoot,
      "packages/command-hook/assets/hooks.json",
    );
    const sparseDestination = join(sparseRoot, "existing-sparse-destination");
    const handle = await open(sparseSource, "w");
    try {
      await handle.truncate(64 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    await write(sparseRoot, "existing-sparse-destination/marker.txt", "keep\n");
    await expect(stagePlugin(sparseRoot, sparseDestination)).rejects.toThrow(
      "bounded byte length",
    );
    expect(await readFile(join(sparseDestination, "marker.txt"), "utf8")).toBe(
      "keep\n",
    );
  });

  test("rejects noncanonical bytes at canonical and staged logo paths", async () => {
    const { stagePlugin } = await import("../src/plugin-package.ts");
    const canonicalRoot = await fixture();
    const destination = join(canonicalRoot, "existing-logo-destination");
    await enableIntendedLogo(canonicalRoot);
    await write(
      canonicalRoot,
      "packages/plugin-builder/template/assets/logo.png",
      "I am sentient.\n",
    );
    await write(
      canonicalRoot,
      "existing-logo-destination/marker.txt",
      "keep\n",
    );
    await expect(stagePlugin(canonicalRoot, destination)).rejects.toThrow(
      "pinned canonical PNG asset",
    );
    expect(await readFile(join(destination, "marker.txt"), "utf8")).toBe(
      "keep\n",
    );

    const stagedRoot = await fixture();
    const staged = join(stagedRoot, "language-stage");
    await enableIntendedLogo(stagedRoot);
    await mkdir(staged, { recursive: true });
    await prepareLanguageStage(stagedRoot, staged);
    await mkdir(join(staged, ".codex-plugin"), { recursive: true });
    await copyFile(
      join(
        stagedRoot,
        "packages/plugin-builder/template/.codex-plugin/plugin.json",
      ),
      join(staged, ".codex-plugin/plugin.json"),
    );
    await mkdir(join(staged, "assets"), { recursive: true });
    await copyFile(
      join(stagedRoot, "packages/plugin-builder/template/assets/logo.png"),
      join(staged, "assets/logo.png"),
    );
    await write(stagedRoot, "language-stage/assets/logo.png", "not a PNG\n");
    await expect(
      validateStagedShippedLanguage(stagedRoot, staged),
    ).rejects.toThrow("pinned canonical PNG asset");
  });

  test("rejects staged nested language and altered or unclassified policy surfaces", async () => {
    const root = await fixture();
    const staged = join(root, "language-stage");
    await mkdir(staged, { recursive: true });
    await prepareLanguageStage(root, staged);
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

  test("parses staged plist content without resolving declarations", async () => {
    const root = await fixture();
    const staged = join(root, "language-stage");
    await mkdir(staged, { recursive: true });
    await prepareLanguageStage(root, staged);
    await write(
      root,
      "language-stage/assets/example.plist",
      // biome-ignore lint/security/noSecrets: Deliberate prohibited-language CDATA fixture, not a credential.
      "<plist><dict><key><![CDATA[I am sentient]]></key></dict></plist>\n",
    );
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "consciousness-sentience-embodiment",
    );

    for (const splitClaim of [
      // biome-ignore lint/security/noSecrets: Deliberate split prohibited-language plist fixture, not a credential.
      "<plist><string>I am sen<![CDATA[ti]]>ent</string></plist>\n",
      // biome-ignore lint/security/noSecrets: Deliberate adjacent-CDATA prohibited-language fixture, not a credential.
      "<plist><string>I am <![CDATA[sen]]><![CDATA[tient]]></string></plist>\n",
    ]) {
      await write(root, "language-stage/assets/example.plist", splitClaim);
      await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
        "consciousness-sentience-embodiment",
      );
    }

    await write(
      root,
      "language-stage/assets/example.plist",
      "<plist><string>I am &#x73;entient</string></plist>\n",
    );
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "consciousness-sentience-embodiment",
    );

    for (const malformed of [
      "<plist><string>neutral</plist>\n",
      '<!DOCTYPE plist SYSTEM "file:///etc/passwd"><plist/>\n',
      '<!ENTITY hidden SYSTEM "file:///etc/passwd"><plist/>\n',
      // biome-ignore lint/security/noSecrets: Deliberate unresolved entity fixture, not a credential.
      "<plist><string>&custom;</string></plist>\n",
    ]) {
      await write(root, "language-stage/assets/example.plist", malformed);
      await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
        "plist/XML",
      );
    }

    await write(
      root,
      "language-stage/assets/example.plist",
      "<plist><string>neutral</string></plist>\n",
    );
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
    for (const encoded of [
      "before\\u0085after",
      "sen\\u200btient",
      "sen\\ufefftient",
      "sen\\ufe0ftient",
      "sen\\u034ftient",
      "sentient\\ufe0f",
      "sentient\\u034f",
    ]) {
      await write(
        root,
        "language-stage/config/controls.json",
        `{"message":"${encoded}"}\n`,
      );
      let controlMessage = "";
      try {
        await validateStagedShippedLanguage(root, staged);
      } catch (error) {
        controlMessage = error instanceof Error ? error.message : String(error);
      }
      expect(controlMessage).toContain("has unsafe path or text controls");
      expect(controlMessage).not.toContain("sentient");
    }
  });

  test("redacts unsafe Unicode diagnostic paths", async () => {
    for (const separator of [
      "\u0085",
      "\u200b",
      "\u2028",
      "\u2029",
      "\ufeff",
      "\ufe0f",
      "\u034f",
    ]) {
      const root = await fixture();
      const staged = join(root, "language-stage");
      await mkdir(staged, { recursive: true });
      await prepareLanguageStage(root, staged);
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

  test("bounds plist XML depth, nodes, attributes, and collected text", async () => {
    const root = await fixture();
    const staged = join(root, "language-stage");
    await mkdir(staged, { recursive: true });
    await prepareLanguageStage(root, staged);
    const path = "language-stage/assets/bounded.plist";
    const cases = [
      `<plist>${"<array>".repeat(65)}<string>neutral</string>${"</array>".repeat(65)}</plist>\n`,
      `<plist>${"<array>".repeat(1_000)}<string>neutral</string>${"</array>".repeat(1_000)}</plist>\n`,
      `<plist>${"<true/>".repeat(500_000)}</plist>\n`,
      `<plist ${Array.from({ length: 65 }, (_, index) => `a${index}="x"`).join(" ")}/>\n`,
      `<plist><string>${"x".repeat(8 * 1024 * 1024 + 1)}</string></plist>\n`,
    ];
    for (const content of cases) {
      await write(root, path, content);
      await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
        "exceeds semantic scan bounds",
      );
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
    await prepareLanguageStage(root, staged);
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
