// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  copyFile,
  cp,
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
import { createTestWorkspace, write } from "./plugin-package-fixture.ts";

const { cleanup, fixture } = createTestWorkspace();
const INVALID_UTF8_LEADING_BYTE = 255;
const OVERSIZED_OPENAI_METADATA_BYTES = 65_537;
afterEach(cleanup);

async function rejectsMetadata(root: string, needle: string): Promise<void> {
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from test cases.
  await expect(validateCanonicalSkillMetadata(root)).rejects.toThrow(needle);
}

async function skill(root: string, content: string): Promise<void> {
  await write(root, "skills/example/SKILL.md", content);
}

describe("canonical skill metadata", () => {
  it("accepts every real canonical skill", async () => {
    await expect(
      validateCanonicalSkillMetadata(resolve(import.meta.dir, "../../..")),
    ).resolves.toBeUndefined();
  });

  it("rejects missing, malformed, non-zero, and unterminated frontmatter", async () => {
    const root = await fixture();
    await skill(root, "name: example\ndescription: Fixture skill.\n");
    await rejectsMetadata(root, "must start with YAML frontmatter at byte 0");

    await skill(root, "---\nname: [broken\ndescription: x\n---\n");
    await rejectsMetadata(root, "contains invalid YAML");

    await skill(root, " \n---\nname: example\ndescription: x\n---\n");
    await rejectsMetadata(root, "must start with YAML frontmatter at byte 0");

    await skill(root, "---\nname: example\ndescription: x\n");
    await rejectsMetadata(root, "frontmatter must end with an exact --- line");
  });

  it("requires exact frontmatter keys and matching directory name", async () => {
    const root = await fixture();
    await skill(root, "---\nname: other\ndescription: x\nextra: true\n---\n");
    await rejectsMetadata(
      root,
      "frontmatter keys must be exactly: description, name",
    );

    await skill(root, "---\nname: other\ndescription: x\n---\n");
    await rejectsMetadata(root, "name must match skill directory");

    await skill(root, "---\nname: example\ndescription: x\n---\n");
    await rejectsMetadata(root, "skill body must be nonempty");
  });

  it("rejects YAML aliases, tags, and merge keys", async () => {
    const root = await fixture();
    await skill(
      root,
      "---\nbase: &base {description: x}\nname: example\ndescription: x\nmerged: *base\n---\n",
    );
    await rejectsMetadata(
      root,
      "must not contain YAML aliases, anchors, tags, or merge keys",
    );

    await skill(
      root,
      "---\nname: example\nname: repeated\ndescription: x\n---\nbody\n",
    );
    await rejectsMetadata(root, "contains invalid YAML");

    await skill(
      root,
      "---\nname: example\ndescription: x\n<<: {other: value}\n---\nbody\n",
    );
    await rejectsMetadata(
      root,
      "must not contain YAML aliases, anchors, tags, or merge keys",
    );

    await skill(root, "---\nname: example\ndescription: !str x\n---\n");
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
      "interface:\n  display_name: Example\n  short_description: Example\n  brand_color: blue\npolicy:\n  allow_implicit_invocation: true\n",
    );
    await rejectsMetadata(root, "brand_color must use canonical #RRGGBB");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      "interface:\n  display_name: Example\n  short_description: Example\npolicy:\n  allow_implicit_invocation: maybe\n",
    );
    await rejectsMetadata(root, "allow_implicit_invocation must be a boolean");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      "interface:\n  display_name: Example\n  short_description: Example\n  icon_small: ../secret.png\n",
    );
    await rejectsMetadata(
      root,
      "icon_small must be a contained relative asset path",
    );

    await write(
      root,
      "skills/example/agents/openai.yaml",
      "interface: {}\ndependencies:\n  tools:\n    - type: mcp\n      value: openaiDeveloperDocs\n      description: OpenAI Docs MCP server\n      transport: streamable_http\n      url: https://developers.openai.com/mcp\n",
    );
    await expect(validateCanonicalSkillMetadata(root)).resolves.toBeUndefined();
  });

  it("rejects unsupported dependency declarations and unknown keys", async () => {
    const root = await fixture();
    await write(
      root,
      "skills/example/agents/openai.yaml",
      "interface:\n  display_name: Example\n  short_description: Example\npolicy:\n  allow_implicit_invocation: true\nunknown: true\n",
    );
    await rejectsMetadata(root, "contains unsupported key");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      "dependencies:\n  tools:\n    - type: package\n      value: example\n",
    );
    await rejectsMetadata(root, "dependency type must be mcp");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      "dependencies:\n  tools:\n    - type: mcp\n      value: docs\n      transport: streamable_http\n      url: http://localhost/mcp\n",
    );
    await rejectsMetadata(root, "must be a safe HTTPS URL");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      "dependencies:\n  tools:\n    - type: mcp\n      value: docs\n      transport: streamable_http\n      url: https://[::ffff:127.0.0.1]/mcp\n",
    );
    await rejectsMetadata(root, "must be a safe HTTPS URL");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      "dependencies:\n  tools:\n    - type: mcp\n      value: docs\n    - type: mcp\n      value: docs\n",
    );
    await rejectsMetadata(root, "duplicate MCP dependency");
  });

  it("enforces UTF-8, LF, and bounded metadata files", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "skills/example/SKILL.md"),
      new Uint8Array([INVALID_UTF8_LEADING_BYTE]),
    );
    await rejectsMetadata(root, "must be valid UTF-8");

    await skill(
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
    const root = await fixture();
    await write(root, "skills/example/icon.png", "icon");
    await symlink("icon.png", join(root, "skills/example/icon-link"));
    await write(
      root,
      "skills/example/agents/openai.yaml",
      "interface:\n  display_name: Example\n  short_description: Example\n  icon_small: ./icon-link\n",
    );
    await rejectsMetadata(root, "is a symlink");

    const skillPath = join(root, "skills/example/SKILL.md");
    await rename(skillPath, join(root, "skills/example/original-skill.md"));
    await symlink("original-skill.md", skillPath);
    await rejectsMetadata(root, "is a symlink");
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
