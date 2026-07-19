// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertExactSkillMetadataFixtureBindings,
  SKILL_METADATA_FIXTURE_BINDINGS,
} from "../../src/skill-metadata/official/v1/contract.ts";
import { validateCanonicalSkillMetadata } from "../../src/skill-metadata/validation/metadata.ts";
import {
  assertPinnedFixtureContent,
  assertPinnedProvenance,
  pinnedFixture,
  rejectsMetadata,
  writeSkill,
} from "../fixtures/skill-metadata/v1/harness.ts";
import { createTestWorkspace, write } from "../plugin/fixture.ts";

const { cleanup, fixture } = createTestWorkspace();
const INVALID_UTF8_LEADING_BYTE = 255;
const OVERSIZED_OPENAI_METADATA_BYTES = 65_537;
afterEach(cleanup);

describe("canonical skill metadata", () => {
  it("accepts every real canonical skill", async () => {
    await expect(
      validateCanonicalSkillMetadata(resolve(import.meta.dir, "../../../..")),
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
    await writeSkill(root, await pinnedFixture("official/valid/SKILL.md"));
    await write(
      root,
      "skills/example/agents/openai.yaml",
      await pinnedFixture("official/valid/openai.yaml"),
    );
    await expect(validateCanonicalSkillMetadata(root)).resolves.toBeUndefined();

    await writeSkill(
      root,
      await pinnedFixture("official/invalid-description/SKILL.md"),
    );
    await rejectsMetadata(root, "must not contain angle-bracket markup");

    await writeSkill(
      root,
      "---\nname: example\ndescription: Use ＜unsafe＞ compatibility markup.\n---\nbody\n",
    );
    await rejectsMetadata(root, "must not contain angle-bracket markup");

    await assertPinnedProvenance();
  });

  it("rejects removable, reordered, extended, and byte-mutated fixture provenance", async () => {
    expect.hasAssertions();
    const bindings = SKILL_METADATA_FIXTURE_BINDINGS.map((binding) => ({
      ...binding,
    }));
    for (const mutation of [
      [],
      bindings.slice(1),
      [...bindings].reverse(),
      [...bindings, { file: "extra.yaml", sha256: "0".repeat(64) }],
    ]) {
      expect(() => assertExactSkillMetadataFixtureBindings(mutation)).toThrow(
        "differ from the pinned inventory",
      );
    }
    const mutatedFixture = new TextEncoder().encode(
      `${await pinnedFixture("official/valid/openai.yaml")}# mutation\n`,
    );
    expect(() =>
      assertPinnedFixtureContent("official/valid/openai.yaml", mutatedFixture),
    ).toThrow("fixture bytes differ from the pinned digest");
  });

  it("executes the pinned Codex 0.144.5 metadata contract fixtures", async () => {
    const root = await fixture();
    await write(root, "skills/example/assets/icon.png", "runtime-icon");
    await write(
      root,
      "skills/example/agents/openai.yaml",
      await pinnedFixture("runtime/valid/openai.yaml"),
    );
    await expect(validateCanonicalSkillMetadata(root)).resolves.toBeUndefined();

    await write(
      root,
      "skills/example/agents/openai.yaml",
      await pinnedFixture("runtime/invalid/openai.yaml"),
    );
    await rejectsMetadata(
      root,
      "icon_small must be a contained relative asset path",
    );
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
      await pinnedFixture("official/valid/openai.yaml"),
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

    for (const continuation of ["_", ":", "A", "z", "0", "-"]) {
      // biome-ignore lint/performance/noAwaitInLoops: each runtime continuation byte is an independent mention-boundary contract.
      await write(
        root,
        "skills/example/agents/openai.yaml",
        `interface:\n  default_prompt: "Use $example${continuation}other now."\n`,
      );
      // biome-ignore lint/performance/noAwaitInLoops: deterministic fixture validation is intentionally sequential.
      await rejectsMetadata(root, "must explicitly mention $example");
    }

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'interface:\n  default_prompt: "Use $example, then continue."\n',
    );
    await expect(validateCanonicalSkillMetadata(root)).resolves.toBeUndefined();
  });

  it("enforces executable runtime lengths and rejects invisible UI values", async () => {
    expect.hasAssertions();
    const root = await fixture();
    await write(
      root,
      "skills/example/agents/openai.yaml",
      `interface:\n  display_name: "${"x".repeat(65)}"\n`,
    );
    await rejectsMetadata(
      root,
      "display_name must be a nonempty bounded string",
    );

    await write(
      root,
      "skills/example/agents/openai.yaml",
      `interface:\n  default_prompt: "$example ${"x".repeat(1016)}"\n`,
    );
    await rejectsMetadata(
      root,
      "default_prompt must be a nonempty bounded string",
    );

    for (const invisible of ["\u200B", "\u2060", "\uFEFF"]) {
      // biome-ignore lint/performance/noAwaitInLoops: each default-ignorable code point is an independent UI spoofing probe.
      await write(
        root,
        "skills/example/agents/openai.yaml",
        `interface:\n  display_name: "Example${invisible} Skill"\n`,
      );
      // biome-ignore lint/performance/noAwaitInLoops: deterministic fixture validation is intentionally sequential.
      await rejectsMetadata(
        root,
        "display_name must be a nonempty bounded string",
      );
    }
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
    await rejectsMetadata(root, "dependency type must be mcp or cli");

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
      'dependencies:\n  tools:\n    - type: "mcp"\n      value: "github"\n    - type: "mcp"\n      value: "github"\n',
    );
    await rejectsMetadata(root, "duplicate dependency identity");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'dependencies:\n  tools:\n    - type: "mcp"\n      value: "local-gh"\n      command: "attacker-command"\n',
    );
    await rejectsMetadata(root, "must match an approved local MCP command");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'policy:\n  products:\n    - "codex"\n    - "CODEX"\n',
    );
    await rejectsMetadata(root, "policy.products contains a duplicate product");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'policy:\n  products:\n    - "desktop"\n',
    );
    await rejectsMetadata(
      root,
      "policy.products contains an unsupported product",
    );

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'dependencies:\n  tools:\n    - type: "mcp"\n      value: "attackerDefinedConnector"\n',
    );
    await rejectsMetadata(root, "must match an approved bare MCP identity");

    await write(
      root,
      "skills/example/agents/openai.yaml",
      'dependencies:\n  tools:\n    - type: "cli"\n      value: "attacker-defined-cli"\n',
    );
    await rejectsMetadata(root, "must match an approved CLI identity");
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
});
