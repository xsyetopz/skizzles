// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateStagedShippedLanguage } from "../../src/shipped-language/validation.ts";
import { write } from "../plugin/fixture.ts";
import { createShippedLanguageTestContext } from "./support.ts";

const { cleanup, fixture, prepareLanguageStage } =
  createShippedLanguageTestContext();
afterEach(cleanup);

describe("plugin shipped-language composition and structured formats", () => {
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
      // biome-ignore lint/security/noSecrets: Deliberate semicolonless entity-obfuscated URL fixture, not a credential.
      '<a href="jav&#x61script:alert(1)">neutral</a>\n',
      // biome-ignore lint/security/noSecrets: Deliberate semicolonless entity-obfuscated URL fixture, not a credential.
      '<a href="jav&#97script:alert(1)">neutral</a>\n',
      // biome-ignore lint/security/noSecrets: Deliberate semicolonless entity-obfuscated URL fixture, not a credential.
      '<a href="javascript&#58alert(1)">neutral</a>\n',
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
    const { stagePlugin } = await import("../../src/plugin/api.ts");
    for (const markup of [
      // biome-ignore lint/security/noSecrets: Deliberate active HTML fixture, not a credential.
      '<img src="x" onerror="alert(1)">\n',
      // biome-ignore lint/security/noSecrets: Deliberate executable namespace fixture, not a credential.
      '<svg onload="alert(1)"></svg>\n',
      '<a href="javascript:alert(1)">neutral</a>\n',
      // biome-ignore lint/security/noSecrets: Deliberate entity-obfuscated URL fixture, not a credential.
      '<a href="java&#x73;cript:alert(1)">neutral</a>\n',
      // biome-ignore lint/security/noSecrets: Deliberate semicolonless entity-obfuscated URL fixture, not a credential.
      '<a href="jav&#x61script:alert(1)">neutral</a>\n',
      // biome-ignore lint/security/noSecrets: Deliberate semicolonless entity-obfuscated URL fixture, not a credential.
      '<a href="jav&#97script:alert(1)">neutral</a>\n',
      // biome-ignore lint/security/noSecrets: Deliberate semicolonless entity-obfuscated URL fixture, not a credential.
      '<a href="javascript&#58alert(1)">neutral</a>\n',
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
        // biome-ignore lint/security/noSecrets: Deliberate greedy semicolonless numeric-reference fixture, not a credential.
        '<span title="I am &#x73entient">neutral</span>',
        '<span title="I am &amp;#115;entient">neutral</span>',
        '<span title="neutral &#128; value">neutral</span>',
        "| Left | Center | Right |",
        "| :--- | :----: | ----: |",
        "| one | two | three |",
        "```text",
        "cargo check -p <package>",
        "```",
      ].join("\n"),
    );
    await expect(
      validateStagedShippedLanguage(root, staged),
    ).resolves.toBeUndefined();
  });

  test("accepts aligned GFM tables through full staging and rejects non-cell alignment", async () => {
    const { stagePlugin } = await import("../../src/plugin/api.ts");
    const acceptedRoot = await fixture();
    const acceptedDestination = join(acceptedRoot, "aligned-table-plugin");
    await write(
      acceptedRoot,
      "skills/example/aligned-table.md",
      [
        '<span title="neutral &copycat value"></span>',
        '<span title="neutral &unknown; value"></span>',
        '<span title="neutral &amp;#115; value"></span>',
        '<span title="I am your friend&#146;s coding assistant"></span>',
        "| Left | Center | Right |",
        "| :--- | :----: | ----: |",
        "| one | two | three |",
        "",
      ].join("\n"),
    );
    await expect(
      stagePlugin(acceptedRoot, acceptedDestination),
    ).resolves.toBeUndefined();
    expect(
      await readFile(
        join(acceptedDestination, "skills/example/aligned-table.md"),
        "utf8",
      ),
    ).toContain("| :--- | :----: | ----: |");

    for (const markup of [
      // biome-ignore lint/security/noSecrets: Deliberate misplaced table alignment fixture, not a credential.
      '<table align="left"><tr><td>neutral</td></tr></table>\n',
      // biome-ignore lint/security/noSecrets: Deliberate misplaced table alignment fixture, not a credential.
      '<table><tr align="center"><td>neutral</td></tr></table>\n',
      // biome-ignore lint/security/noSecrets: Deliberate invalid table alignment fixture, not a credential.
      '<table><tr><td align="justify">neutral</td></tr></table>\n',
      // biome-ignore lint/security/noSecrets: Deliberate noncanonical table alignment fixture, not a credential.
      '<table><tr><td align="LEFT">neutral</td></tr></table>\n',
    ]) {
      const root = await fixture();
      const destination = join(root, "existing-table-destination");
      await write(root, "skills/example/invalid-table.md", markup);
      await write(root, "existing-table-destination/marker.txt", "preserve\n");
      await expect(stagePlugin(root, destination)).rejects.toThrow(
        "rendered Markdown HTML",
      );
      expect(await readFile(join(destination, "marker.txt"), "utf8")).toBe(
        "preserve\n",
      );
    }
  });

  test("preserves C1 reference provenance through full Markdown staging", async () => {
    const { stagePlugin } = await import("../../src/plugin/api.ts");
    const longZeros = "0".repeat(1024);
    const root = await fixture();
    const destination = join(root, "plain-markdown-apostrophes");
    await write(
      root,
      "skills/example/plain-apostrophes.md",
      [
        "I am your friend&#39;s coding assistant.",
        "I am your friend&#x27s coding assistant.",
        "I am your friend&#X00027;s coding assistant.",
        "I am your friend&#146;s coding assistant.",
        "I am your friend&#x92s coding assistant.",
        "I am your friend&#X00092;s coding assistant.",
        "I am your friend&#8217;s coding assistant.",
        // biome-ignore lint/security/noSecrets: Deliberate encoded apostrophe fixture, not a credential.
        "I am your friend&#x2019s coding assistant.",
        `I am your friend&#${longZeros}8217;s coding assistant.`,
        `I am your friend&#X${longZeros}2019s coding assistant.`,
        "",
      ].join("\n"),
    );
    await expect(stagePlugin(root, destination)).resolves.toBeUndefined();

    for (const [claim, diagnostic] of [
      [
        "I am your friend\u0092s coding assistant.\n",
        "unsafe path or text controls",
      ],
      [
        "I am your friend&#150;truly and personally.\n",
        "friendship-attachment-reciprocity",
      ],
      [
        "I am your friend&#x97;truly and personally.\n",
        "friendship-attachment-reciprocity",
      ],
      [
        "I am your friend&#39; truly and personally.\n",
        "friendship-attachment-reciprocity",
      ],
    ] as const) {
      const rejectedRoot = await fixture();
      const rejectedDestination = join(rejectedRoot, "existing-c1-destination");
      await write(rejectedRoot, "skills/example/c1.md", claim);
      await write(
        rejectedRoot,
        "existing-c1-destination/marker.txt",
        "preserve\n",
      );
      await expect(
        stagePlugin(rejectedRoot, rejectedDestination),
      ).rejects.toThrow(diagnostic);
      expect(
        await readFile(join(rejectedDestination, "marker.txt"), "utf8"),
      ).toBe("preserve\n");
    }
  });
});
