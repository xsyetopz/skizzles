// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SHIPPED_LANGUAGE_POLICY_PATHS } from "@skizzles/prompt-layer";
import { validateStagedShippedLanguage } from "../src/shipped-language/validation.ts";
import { requiredTestRecord, write } from "./plugin-package-fixture.ts";
import { createShippedLanguageTestContext } from "./shipped-language-test-context.ts";

const { cleanup, fixture, mutateJson, prepareLanguageStage } =
  createShippedLanguageTestContext();
afterEach(cleanup);

describe("plugin shipped-language composition and structured formats", () => {
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
      [
        "skills/example/visible-attribute.md",
        '<img alt="I am &#x73;entient">\n',
      ],
      [
        "skills/example/title-attribute.md",
        '<span title="I am &#x73;entient"></span>\n',
      ],
      [
        "skills/example/aria-attribute.md",
        '<span aria-label="I am &#x73;entient"></span>\n',
      ],
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
      // biome-ignore lint/security/noSecrets: Deliberate active HTML fixture, not a credential.
      '<img src="x" onerror="alert(1)">\n',
      // biome-ignore lint/security/noSecrets: Deliberate executable namespace fixture, not a credential.
      '<svg onload="alert(1)"></svg>\n',
      '<a href="javascript:alert(1)">neutral</a>\n',
      // biome-ignore lint/security/noSecrets: Deliberate entity-obfuscated URL fixture, not a credential.
      '<a href="java&#x73;cript:alert(1)">neutral</a>\n',
      // biome-ignore lint/security/noSecrets: Deliberate NFKC-obfuscated URL fixture, not a credential.
      '<a href="ｊａｖａｓｃｒｉｐｔ：alert(1)">neutral</a>\n',
      // biome-ignore lint/security/noSecrets: Deliberate duplicate attribute fixture, not a credential.
      '<img alt="neutral" alt="duplicate">\n',
      '<img alt="neutral&#xfe0f;">\n',
      '<span style="color:red">neutral</span>\n',
    ]) {
      await write(root, "language-stage/skills/example/markup.md", markup);
      await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
        "rendered Markdown HTML",
      );
    }
  });

  test("rejects active rendered HTML through full staging without mutation", async () => {
    const { stagePlugin } = await import("../src/plugin-package.ts");
    for (const markup of [
      // biome-ignore lint/security/noSecrets: Deliberate active HTML fixture, not a credential.
      '<img src="x" onerror="alert(1)">\n',
      // biome-ignore lint/security/noSecrets: Deliberate executable namespace fixture, not a credential.
      '<svg onload="alert(1)"></svg>\n',
      '<a href="javascript:alert(1)">neutral</a>\n',
      // biome-ignore lint/security/noSecrets: Deliberate entity-obfuscated URL fixture, not a credential.
      '<a href="java&#x73;cript:alert(1)">neutral</a>\n',
    ]) {
      const root = await fixture();
      const destination = join(root, "existing-html-destination");
      await write(root, "skills/example/active.md", markup);
      await write(root, "existing-html-destination/marker.txt", "preserve\n");
      let message = "";
      try {
        await stagePlugin(root, destination);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("rendered Markdown HTML");
      expect(message).not.toContain("alert");
      expect(await readFile(join(destination, "marker.txt"), "utf8")).toBe(
        "preserve\n",
      );
    }
  });

  test("accepts inert Markdown elements and scans visible attributes", async () => {
    const root = await fixture();
    const staged = join(root, "language-stage");
    await mkdir(staged, { recursive: true });
    await prepareLanguageStage(root, staged);
    await write(
      root,
      "language-stage/skills/example/inert.md",
      [
        '[neutral link](https://example.com "neutral title")',
        '![neutral alt](./image.png "neutral image")',
        "- [x] neutral task",
        '<span aria-label="neutral label">neutral</span>',
        "```text",
        "cargo check -p <package>",
        "```",
      ].join("\n"),
    );
    await expect(
      validateStagedShippedLanguage(root, staged),
    ).resolves.toBeUndefined();
  });
});
