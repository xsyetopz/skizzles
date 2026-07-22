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
import { dirname, join } from "node:path";
import { SHIPPED_LANGUAGE_POLICY_PATHS } from "@skizzles/prompt-layer";
import {
  validateCanonicalShippedLanguage,
  validateStagedShippedLanguage,
} from "../../src/shipped-language/validation.ts";
import { write } from "../plugin/fixture.ts";
import { createShippedLanguageTestContext } from "./support.ts";

const { cleanup, enableIntendedLogo, fixture, prepareLanguageStage } =
  createShippedLanguageTestContext();
afterEach(cleanup);

describe("plugin shipped-language filesystem and resource boundaries", () => {
  test("rejects singular canonical symlinks before destination mutation", async () => {
    const { stagePlugin } = await import("../../src/plugin/api.ts");
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
    const { stagePlugin } = await import("../../src/plugin/api.ts");
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
    const { stagePlugin } = await import("../../src/plugin/api.ts");
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
      "<plist><dict><key><![CDATA[I am sentient]]></key></dict></plist>\n",
    );
    await expect(validateStagedShippedLanguage(root, staged)).rejects.toThrow(
      "consciousness-sentience-embodiment",
    );

    for (const splitClaim of [
      "<plist><string>I am sen<![CDATA[ti]]>ent</string></plist>\n",

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
      `<plist>${"<array>".repeat(65)}<string>neutral</string>${"</array>".repeat(
        65,
      )}</plist>\n`,
      `<plist>${"<array>".repeat(1_000)}<string>neutral</string>${"</array>".repeat(
        1_000,
      )}</plist>\n`,
      `<plist>${"<true/>".repeat(500_000)}</plist>\n`,
      `<plist ${Array.from({ length: 65 }, (_, index) => `a${index}="x"`).join(
        " ",
      )}/>\n`,
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
    const { stagePlugin } = await import("../../src/plugin/api.ts");
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
