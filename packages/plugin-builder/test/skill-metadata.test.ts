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
import { join, resolve } from "node:path";
import { stagePlugin } from "../src/plugin-package.ts";
import {
  validateCanonicalSkillMetadata,
  validateStagedSkillMetadata,
} from "../src/skill-metadata/validation.ts";
import {
  assertPinnedProvenance,
  pinnedFixture,
  rejectsMetadata,
  writeSkill,
} from "./fixtures/skill-metadata/v1/fixture.ts";
import { createTestWorkspace, write } from "./plugin-package-fixture.ts";

const { cleanup, fixture } = createTestWorkspace();
const INVALID_UTF8_LEADING_BYTE = 255;
const OVERSIZED_OPENAI_METADATA_BYTES = 65_537;
afterEach(cleanup);

describe("canonical skill metadata", () => {
  it("accepts every real canonical skill", async () => {
    await expect(
      validateCanonicalSkillMetadata(resolve(import.meta.dir, "../../..")),
    ).resolves.toBeUndefined();
  });

  it("rejects missing, malformed, non-zero, and unterminated frontmatter", async () => {
    expect.hasAssertions();
    const root = await fixture();
    await writeSkill(root, "name: example\ndescription: Fixture skill.\n");
    await rejectsMetadata(root, "must start with YAML frontmatter at byte 0");

    await writeSkill(root, "---\nname: [broken\ndescription: x\n---\n");
    await rejectsMetadata(root, "contains invalid YAML");

    await writeSkill(root, " \n---\nname: example\ndescription: x\n---\n");
    await rejectsMetadata(root, "must start with YAML frontmatter at byte 0");

    await writeSkill(root, "---\nname: example\ndescription: x\n");
    await rejectsMetadata(root, "frontmatter must end with an exact --- line");
  });

  it("requires exact frontmatter keys and matching directory name", async () => {
    expect.hasAssertions();
    const root = await fixture();
    await writeSkill(
      root,
      "---\nname: other\ndescription: x\nextra: true\n---\n",
    );
    await rejectsMetadata(root, "frontmatter contains unsupported key");

    await writeSkill(root, "---\nname: other\ndescription: x\n---\n");
    await rejectsMetadata(root, "name must match skill directory");

    await writeSkill(root, "---\nname: bad--name\ndescription: x\n---\nbody\n");
    await rejectsMetadata(root, "name must use canonical kebab-case");

    await writeSkill(root, "---\nname: example\ndescription: x\n---\n");
    await rejectsMetadata(root, "must contain visible instructional content");
  });

  it("accepts each official optional frontmatter field independently", async () => {
    for (const optionalField of [
      "license: MIT",
      "allowed-tools: Bash(git:*) Read",
      'metadata:\n  author: OpenAI\n  version: "1.0"',
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each field gets an independent workspace and causal validation.
      const root = await fixture();
      await writeSkill(
        root,
        `---\nname: example\ndescription: Official optional field fixture.\n${optionalField}\n---\nvisible body\n`,
      );
      await expect(
        validateCanonicalSkillMetadata(root),
      ).resolves.toBeUndefined();
    }
  });

  it("pins current official valid and invalid artifacts with provenance", async () => {
    const root = await fixture();
    await writeSkill(root, await pinnedFixture("official-valid-SKILL.md"));
    await write(
      root,
      "skills/example/agents/openai.yaml",
      await pinnedFixture("official-valid-openai.yaml"),
    );
    await expect(validateCanonicalSkillMetadata(root)).resolves.toBeUndefined();

    await writeSkill(
      root,
      await pinnedFixture("official-invalid-description-SKILL.md"),
    );
    await rejectsMetadata(root, "must not contain angle-bracket markup");

    await writeSkill(
      root,
      "---\nname: example\ndescription: Use ＜unsafe＞ compatibility markup.\n---\nbody\n",
    );
    await rejectsMetadata(root, "must not contain angle-bracket markup");

    await assertPinnedProvenance();
  });

  it("rejects YAML aliases, tags, and merge keys", async () => {
    expect.hasAssertions();
    const root = await fixture();
    await writeSkill(
      root,
      "---\nbase: &base {description: x}\nname: example\ndescription: x\nmerged: *base\n---\n",
    );
    await rejectsMetadata(
      root,
      "must not contain YAML aliases, anchors, tags, or merge keys",
    );

    await writeSkill(
      root,
      "---\nname: example\nname: repeated\ndescription: x\n---\nbody\n",
    );
    await rejectsMetadata(root, "contains invalid YAML");

    await writeSkill(
      root,
      "---\nname: example\ndescription: x\n<<: {other: value}\n---\nbody\n",
    );
    await rejectsMetadata(
      root,
      "must not contain YAML aliases, anchors, tags, or merge keys",
    );

    await writeSkill(root, "---\nname: example\ndescription: !str x\n---\n");
    await rejectsMetadata(
      root,
      "must not contain YAML aliases, anchors, tags, or merge keys",
    );
  });

  it("validates optional openai.yaml interface and policy fields", async () => {
    const root = await fixture();
    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  display_name: "Example Skill"\n  short_description: "Validate example skill metadata"\n  brand_color: "blue"\npolicy:\n  allow_implicit_invocation: true\n',
    );
    await rejectsMetadata(root, "brand_color must use canonical #RRGGBB");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  display_name: "Example Skill"\n  short_description: "Validate example skill metadata"\npolicy:\n  allow_implicit_invocation: "maybe"\n',
    );
    await rejectsMetadata(root, "allow_implicit_invocation must be a boolean");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  display_name: "Example Skill"\n  short_description: "Validate example skill metadata"\n  icon_small: "../secret.png"\n',
    );
    await rejectsMetadata(
      root,
      "icon_small must be a contained relative asset path",
    );

    await write(
      root,
      "skills/example/agents/openai.yaml",
      await pinnedFixture("official-valid-openai.yaml"),
    );
    await expect(validateCanonicalSkillMetadata(root)).resolves.toBeUndefined();
  });

  it("enforces quoted UI strings, short descriptions, and named prompts", async () => {
    expect.hasAssertions();
    const root = await fixture();
    await write(
      root,
      "skills/example/agents/openai.yaml",
      "interface:\n  display_name: Example Skill\n",
    );
    await rejectsMetadata(
      root,
      "string values must use single or double quotes",
    );

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  short_description: "Too short"\n',
    );
    await rejectsMetadata(root, "must contain 25 to 64 characters");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  default_prompt: "Use this skill to validate metadata."\n',
    );
    await rejectsMetadata(root, "must explicitly mention $example");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  default_prompt: "Use $example-other to validate metadata."\n',
    );
    await rejectsMetadata(root, "must explicitly mention $example");
  });

  it("rejects unsupported dependency declarations and unknown keys", async () => {
    expect.hasAssertions();
    const root = await fixture();
    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  display_name: "Example Skill"\n  short_description: "Validate example skill metadata"\npolicy:\n  allow_implicit_invocation: true\nunknown: true\n',
    );
    await rejectsMetadata(root, "contains unsupported key");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'dependencies:\n  tools:\n    - type: "package"\n      value: "example"\n',
    );
    await rejectsMetadata(root, "dependency type must be mcp");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'dependencies:\n  tools:\n    - type: "mcp"\n      value: "openaiDeveloperDocs"\n      transport: "streamable_http"\n      url: "http://localhost/mcp"\n',
    );
    await rejectsMetadata(root, "must match approved MCP endpoint contract");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'dependencies:\n  tools:\n    - type: "mcp"\n      value: "openaiDeveloperDocs"\n      transport: "streamable_http"\n      url: "https://[::ffff:127.0.0.1]/mcp"\n',
    );
    await rejectsMetadata(root, "must match approved MCP endpoint contract");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'dependencies:\n  tools:\n    - type: "mcp"\n      value: "docs"\n    - type: "mcp"\n      value: "docs"\n',
    );
    await rejectsMetadata(root, "duplicate MCP dependency");
  });

  it("rejects root-dot and dynamic DNS aliases without network lookup", async () => {
    expect.hasAssertions();
    const root = await fixture();
    for (const url of [
      "https://developers.openai.com./mcp",
      "https://127.0.0.1.nip.io/mcp",
      "https://developers-openai.example/mcp",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: every alias is an independent closed-policy probe.
      await write(
        root,
        "skills/example/agents/openai.yaml",
        `dependencies:\n  tools:\n    - type: "mcp"\n      value: "openaiDeveloperDocs"\n      transport: "streamable_http"\n      url: "${url}"\n`,
      );
      await rejectsMetadata(root, "must match approved MCP endpoint contract");
    }
  });

  it("enforces UTF-8, LF, and bounded metadata files", async () => {
    expect.hasAssertions();
    const root = await fixture();
    await writeFile(
      join(root, "skills/example/SKILL.md"),
      new Uint8Array([INVALID_UTF8_LEADING_BYTE]),
    );
    await rejectsMetadata(root, "must be valid UTF-8");

    await writeSkill(
      root,
      "---\r\nname: example\r\ndescription: x\r\n---\r\nbody\r\n",
    );
    await rejectsMetadata(root, "must use LF line endings");

    await mkdir(join(root, "skills/example/agents"), { recursive: true });
    await writeFile(
      join(root, "skills/example/agents/openai.yaml"),
      "x".repeat(OVERSIZED_OPENAI_METADATA_BYTES),
    );
    await rejectsMetadata(root, "size must be between 1 and 65536 bytes");
  });

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
});

describe("staged skill metadata", () => {
  it("rejects staged byte drift and missing or extra metadata", async () => {
    const root = await fixture();
    const staged = join(root, "stage");
    await cp(join(root, "skills"), join(staged, "skills"), {
      recursive: true,
    });
    await writeFile(
      join(staged, "skills/example/SKILL.md"),
      "---\nname: example\ndescription: drift\n---\n",
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
      "---\nname: extra\ndescription: x\n---\n",
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
