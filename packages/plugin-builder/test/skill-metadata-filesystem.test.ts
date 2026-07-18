// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  copyFile,
  cp,
  link,
  mkdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { stagePlugin } from "../src/plugin-package.ts";
import { readStableRegularFile } from "../src/skill-metadata/regular-file-boundary.ts";
import {
  validateCanonicalSkillMetadata,
  validateStagedSkillMetadata,
} from "../src/skill-metadata/validation.ts";
import {
  rejectsMetadata,
  runAncestorSwapProbe,
  writeSkill,
} from "./fixtures/skill-metadata/v1/fixture.ts";
import { createTestWorkspace, write } from "./plugin-package-fixture.ts";

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("canonical skill metadata filesystem boundaries", () => {
  it("rejects unsafe icon symlinks", async () => {
    expect.hasAssertions();
    const root = await fixture();
    await write(root, "skills/example/icon.png", "icon");
    await symlink("icon.png", join(root, "skills/example/icon-link"));
    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  display_name: "Example Skill"\n  short_description: "Validate example skill metadata"\n  icon_small: "./icon-link"\n',
    );
    await rejectsMetadata(root, "must be a self-contained regular file");

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
    const iconPath = join(assetRoot, "skills/example/icon.png");
    await write(assetRoot, "skills/example/icon.png", "icon");
    await link(iconPath, join(assetRoot, "skills/example/icon-copy.png"));
    await write(
      assetRoot,
      "skills/example/agents/openai.yaml",
      'interface:\n  icon_small: "./icon.png"\n',
    );
    await rejectsMetadata(assetRoot, "must have exactly one filesystem link");
  });

  it("rejects Unicode-invisible, comment-only, and punctuation-only bodies", async () => {
    const root = await fixture();
    for (const body of [
      // biome-ignore lint/security/noSecrets: explicit Unicode-invisible adversarial fixture, not a credential.
      "\u200B\u200D\uFEFF\u0301\uFE0F",
      "<!-- hidden only -->",
      "# *** ---",
      "🧪✨",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: every invisible class is an independent adversarial fixture.
      await writeSkill(
        root,
        `---\nname: example\ndescription: Visible body fixture.\n---\n${body}\n`,
      );
      await rejectsMetadata(root, "must contain visible instructional content");
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
      // biome-ignore lint/performance/noAwaitInLoops: each hostile name uses an isolated filesystem fixture.
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
    await write(root, "skills/example/icon.png", "BBBB");
    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  icon_small: "./icon.png"\n  icon_large: "./icon.png"\n',
    );
    const staged = join(root, "stage");
    await cp(join(root, "skills"), join(staged, "skills"), { recursive: true });
    await write(staged, "skills/example/icon.png", "AAAA");
    await expect(validateStagedSkillMetadata(root, staged)).rejects.toThrow(
      "staged skill metadata differs from canonical bytes",
    );
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
