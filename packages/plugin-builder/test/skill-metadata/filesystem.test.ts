import { afterEach, describe, expect, it } from "bun:test";
import {
  copyFile,
  cp,
  link,
  mkdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { stagePlugin } from "../../src/plugin/api.ts";
import { readStableRegularFile } from "../../src/skill-metadata/filesystem/regular-file.ts";
import {
  validateCanonicalSkillMetadata,
  validateStagedSkillMetadata,
} from "../../src/skill-metadata/validation/metadata.ts";
import {
  rejectsMetadata,
  runAncestorSwapProbe,
  writeSkill,
} from "../fixtures/skill-metadata/v1/harness.ts";
import { createTestWorkspace, write } from "../plugin/fixture.ts";

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("canonical skill metadata filesystem boundaries", () => {
  it("rejects unsafe icon symlinks", async () => {
    expect.hasAssertions();
    const root = await fixture();
    await write(root, "skills/example/assets/icon.png", "icon");
    await symlink("icon.png", join(root, "skills/example/assets/icon-link"));
    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  display_name: "Example Skill"\n  short_description: "Validate example skill metadata"\n  icon_small: "./assets/icon-link"\n',
    );
    await rejectsMetadata(root, "asset entries must not be symlinks");

    const skillPath = join(root, "skills/example/SKILL.md");
    await rename(skillPath, join(root, "skills/example/original-skill.md"));
    await symlink("original-skill.md", skillPath);
    await rejectsMetadata(root, "must be a self-contained regular file");
  });

  it("rejects hard-linked skill, OpenAI metadata, and icon files", async () => {
    expect.hasAssertions();
    const skillRoot = await fixture();
    const skillPath = join(skillRoot, "skills/example/SKILL.md");
    const originalSkill = join(skillRoot, "skills/example/original-skill.md");
    await rename(skillPath, originalSkill);
    await link(originalSkill, skillPath);
    await rejectsMetadata(skillRoot, "must have exactly one filesystem link");

    const openaiRoot = await fixture();
    const openaiPath = join(openaiRoot, "skills/example/agents/openai.yaml");
    await write(
      openaiRoot,
      "skills/example/agents/openai.yaml",
      'interface:\n  display_name: "Example Skill"\n',
    );
    await link(openaiPath, join(openaiRoot, "skills/example/openai-copy.yaml"));
    await rejectsMetadata(openaiRoot, "must have exactly one filesystem link");

    const assetRoot = await fixture();
    const iconPath = join(assetRoot, "skills/example/assets/icon.png");
    await write(assetRoot, "skills/example/assets/icon.png", "icon");
    await link(
      iconPath,
      join(assetRoot, "skills/example/assets/icon-copy.png"),
    );
    await write(
      assetRoot,
      "skills/example/agents/openai.yaml",
      'interface:\n  icon_small: "./assets/icon.png"\n',
    );
    await rejectsMetadata(assetRoot, "must have exactly one filesystem link");
  });

  it("rejects Unicode-invisible, comment-only, and punctuation-only bodies", async () => {
    const root = await fixture();
    for (const body of ["<!-- hidden only -->", "# *** ---", "🧪✨"]) {
      await writeSkill(
        root,
        `---\nname: example\ndescription: Visible body fixture.\n---\n${body}\n`,
      );
      await rejectsMetadata(root, "must contain visible instructional content");
    }

    for (const body of [
      "\u200B\u200D\uFEFF\u0301\uFE0F",

      "visible\u202Einstructions",
    ]) {
      await writeSkill(
        root,
        `---\nname: example\ndescription: Visible body fixture.\n---\n${body}\n`,
      );
      await rejectsMetadata(
        root,
        "skill body contains unsafe invisible or control characters",
      );
    }

    await writeSkill(
      root,
      "---\nname: example\ndescription: Visible body fixture.\n---\n\n# 例\n",
    );
    await expect(validateCanonicalSkillMetadata(root)).resolves.toBeUndefined();
  });

  it("allows a skill without optional openai.yaml", async () => {
    await expect(
      validateCanonicalSkillMetadata(await fixture()),
    ).resolves.toBeUndefined();
  });

  it("redacts attacker-controlled path components in diagnostics", async () => {
    expect.hasAssertions();
    for (const unsafeName of ["bad\nsecret", "名前", "x".repeat(128)]) {
      const root = await fixture();
      await mkdir(join(root, "skills", unsafeName));
      const error = await validateCanonicalSkillMetadata(root).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Distributed skill directory name is invalid.",
      );
      expect((error as Error).message).not.toContain(unsafeName);
    }

    await expect(
      readStableRegularFile("/tmp", "/tmp/attacker\nsecret", 16),
    ).rejects.toThrow(
      "Skill metadata path must remain within its declared root",
    );

    const assetRoot = await fixture();
    const unsafeAssetName = "\u009B-icon.png";
    await write(
      assetRoot,
      `skills/example/assets/${unsafeAssetName}`,
      "unsafe",
    );
    const error = await validateCanonicalSkillMetadata(assetRoot).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Skill asset entry path is unsafe.");
    expect((error as Error).message).not.toContain(unsafeAssetName);
    expect((error as Error).message.split("\n")).toHaveLength(1);
  });

  it("never accepts out-of-root bytes during skill, metadata, and icon ancestor swaps", async () => {
    const root = await fixture();
    const { accepted, canonicalAfterAttack, canonicalSkill } =
      await runAncestorSwapProbe(root);
    for (const { expected, value } of accepted) {
      expect(Buffer.from(value).equals(Buffer.from(expected))).toBe(true);
    }
    expect(
      Buffer.from(canonicalAfterAttack).equals(Buffer.from(canonicalSkill)),
    ).toBe(true);
  });
});

describe("staged skill metadata", () => {
  it("binds icon paths and bytes into canonical/staged parity", async () => {
    const root = await fixture();
    await write(root, "skills/example/assets/icon.png", "BBBB");
    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  icon_small: "./assets/icon.png"\n  icon_large: "./assets/icon.png"\n',
    );
    const staged = join(root, "stage");
    await cp(join(root, "skills"), join(staged, "skills"), { recursive: true });
    await write(staged, "skills/example/assets/icon.png", "AAAA");
    await expect(validateStagedSkillMetadata(root, staged)).rejects.toThrow(
      "staged skill metadata differs from canonical bytes",
    );
  });

  it("inventories every unreferenced asset for exact staged parity", async () => {
    for (const mutation of [
      "extra",
      "missing",
      "drift",
      "symlink",
      "hardlink",
      "excluded",
    ] as const) {
      const root = await fixture();
      await write(root, "skills/example/assets/unreferenced.bin", "canonical");
      const staged = join(root, "stage");
      await cp(join(root, "skills"), join(staged, "skills"), {
        recursive: true,
      });
      if (mutation === "extra") {
        await write(staged, "skills/example/assets/rogue.png", "rogue");
      } else if (mutation === "missing") {
        await unlink(join(staged, "skills/example/assets/unreferenced.bin"));
      } else if (mutation === "drift") {
        await write(
          staged,
          "skills/example/assets/unreferenced.bin",
          "altered",
        );
      } else if (mutation === "symlink") {
        await symlink(
          "unreferenced.bin",
          join(staged, "skills/example/assets/rogue-link"),
        );
      } else if (mutation === "hardlink") {
        const source = join(staged, "skills/example/assets/hardlink-source");
        await writeFile(source, "linked");
        await link(
          source,
          join(staged, "skills/example/assets/rogue-hardlink"),
        );
      } else {
        await write(
          staged,
          "skills/example/assets/node_modules/rogue.js",
          "rogue",
        );
      }

      await expect(validateStagedSkillMetadata(root, staged)).rejects.toThrow();
    }
  });
  it("rejects staged byte drift and missing or extra metadata", async () => {
    const root = await fixture();
    const staged = join(root, "stage");
    await cp(join(root, "skills"), join(staged, "skills"), {
      recursive: true,
    });
    await writeFile(
      join(staged, "skills/example/SKILL.md"),
      "---\nname: example\ndescription: drift\n---\ndrift\n",
    );
    await expect(validateStagedSkillMetadata(root, staged)).rejects.toThrow(
      "metadata differs from canonical bytes",
    );

    await copyFile(
      join(root, "skills/example/SKILL.md"),
      join(staged, "skills/example/SKILL.md"),
    );
    await write(root, "skills/example/agents/openai.yaml", "interface: {}\n");
    await expect(validateStagedSkillMetadata(root, staged)).rejects.toThrow(
      "metadata set differs from canonical",
    );

    await copyFile(
      join(root, "skills/example/SKILL.md"),
      join(staged, "skills/example/SKILL.md"),
    );
    await expect(
      validateStagedSkillMetadata(root, join(root, "missing-stage")),
    ).rejects.toThrow("skill metadata set differs from canonical");

    await mkdir(join(staged, "skills/extra"), { recursive: true });
    await writeFile(
      join(staged, "skills/extra/SKILL.md"),
      "---\nname: extra\ndescription: x\n---\nextra\n",
    );
    await expect(validateStagedSkillMetadata(root, staged)).rejects.toThrow(
      "skill metadata set differs from canonical",
    );
  });

  it("rejects invalid canonical metadata before destination mutation", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    await write(root, "skills/example/SKILL.md", "invalid\n");
    await write(destination, "sentinel.txt", "preserve\n");

    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "must start with YAML frontmatter at byte 0",
    );
    await expect(
      Bun.file(join(destination, "sentinel.txt")).text(),
    ).resolves.toBe("preserve\n");
  });
});
