// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  APPROVED_BARE_MCP_IDENTITIES,
  APPROVED_CLI_IDENTITIES,
  APPROVED_LOCAL_MCP_COMMANDS,
  APPROVED_MCP_ENDPOINTS,
  assertExactSkillMetadataFixtureBindings,
  SKILL_METADATA_CONTRACT_PROVENANCE,
  SKILL_METADATA_CONTRACT_VERSION,
  SKILL_METADATA_FIXTURE_BINDINGS,
} from "../../../../src/skill-metadata/official-contract-v1.ts";
import { readStableRegularFile } from "../../../../src/skill-metadata/regular-file-boundary.ts";
import { validateCanonicalSkillMetadata } from "../../../../src/skill-metadata/validation.ts";
import { write } from "../../../plugin-package-fixture.ts";

function pinnedFixture(name: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${name}`).text();
}

async function rejectsMetadata(root: string, needle: string): Promise<void> {
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from test cases.
  await expect(validateCanonicalSkillMetadata(root)).rejects.toThrow(needle);
}

async function writeSkill(root: string, content: string): Promise<void> {
  await write(root, "skills/example/SKILL.md", content);
}

async function assertPinnedProvenance(): Promise<void> {
  const provenance = await Bun.file(
    `${import.meta.dir}/provenance.json`,
  ).json();
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.version).toBe(SKILL_METADATA_CONTRACT_VERSION);
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.observedCodexCliVersion).toBe(
    SKILL_METADATA_CONTRACT_PROVENANCE.observedCodexCliVersion,
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.executableSource).toEqual(
    SKILL_METADATA_CONTRACT_PROVENANCE.executableSource,
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.sources).toEqual(
    SKILL_METADATA_CONTRACT_PROVENANCE.artifacts,
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.approvedMcpEndpoints).toEqual(APPROVED_MCP_ENDPOINTS);
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.approvedBareMcpIdentities).toEqual(
    APPROVED_BARE_MCP_IDENTITIES,
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.approvedCliIdentities).toEqual(APPROVED_CLI_IDENTITIES);
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.approvedLocalMcpCommands).toEqual(
    APPROVED_LOCAL_MCP_COMMANDS,
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.networkLimitation).toBe(
    SKILL_METADATA_CONTRACT_PROVENANCE.networkLimitation,
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.filesystemLimitation).toBe(
    SKILL_METADATA_CONTRACT_PROVENANCE.filesystemLimitation,
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.repositoryNarrowing).toBe(
    SKILL_METADATA_CONTRACT_PROVENANCE.repositoryNarrowing,
  );
  assertExactSkillMetadataFixtureBindings(provenance.fixtures);
  for (const fixture of SKILL_METADATA_FIXTURE_BINDINGS) {
    // biome-ignore lint/performance/noAwaitInLoops: each declared fixture is independently bound to its recorded digest.
    const bytes = await Bun.file(`${import.meta.dir}/${fixture.file}`).bytes();
    assertPinnedFixtureContent(fixture.file, bytes);
  }
}

function assertPinnedFixtureContent(file: string, bytes: Uint8Array): void {
  const binding = SKILL_METADATA_FIXTURE_BINDINGS.find(
    (candidate) => candidate.file === file,
  );
  if (
    binding === undefined ||
    createHash("sha256").update(bytes).digest("hex") !== binding.sha256
  ) {
    throw new Error(
      "Skill metadata fixture bytes differ from the pinned digest.",
    );
  }
}

interface AncestorSwapProbeResult {
  accepted: ReadonlyArray<{ expected: Uint8Array; value: Uint8Array }>;
  canonicalAfterAttack: Uint8Array;
  canonicalSkill: Uint8Array;
}

async function runAncestorSwapProbe(
  root: string,
): Promise<AncestorSwapProbeResult> {
  const skillDirectory = join(root, "skills/example");
  const parkedDirectory = join(root, "skills/example-canonical");
  const outsideDirectory = join(root, "outside-example");
  const canonical = {
    icon: new TextEncoder().encode("canonical-icon"),
    openai: new TextEncoder().encode(
      'interface:\n  display_name: "Canonical"\n',
    ),
    skill: new TextEncoder().encode(
      "---\nname: example\ndescription: Canonical fixture.\n---\ncanonical\n",
    ),
  };
  await mkdir(join(skillDirectory, "agents"), { recursive: true });
  await mkdir(join(skillDirectory, "assets"), { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), canonical.skill);
  await writeFile(
    join(root, "skills/example/agents/openai.yaml"),
    canonical.openai,
  );
  await writeFile(join(skillDirectory, "assets/icon.png"), canonical.icon);
  await mkdir(join(outsideDirectory, "agents"), { recursive: true });
  await mkdir(join(outsideDirectory, "assets"), { recursive: true });
  await writeFile(join(outsideDirectory, "SKILL.md"), "outside-skill");
  await writeFile(
    join(outsideDirectory, "agents/openai.yaml"),
    "outside-openai",
  );
  await writeFile(join(outsideDirectory, "assets/icon.png"), "outside-icon");

  const swapOnce = async (): Promise<void> => {
    await rename(skillDirectory, parkedDirectory);
    await symlink("../outside-example", skillDirectory);
    await Bun.sleep(0);
    await unlink(skillDirectory);
    await rename(parkedDirectory, skillDirectory);
  };
  let attacking = true;
  const attacker = (async () => {
    try {
      for (let index = 0; index < 150; index += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: the race probe requires serialized complete swap cycles.
        await swapOnce();
      }
    } finally {
      attacking = false;
    }
  })();
  const accepted: Array<{ expected: Uint8Array; value: Uint8Array }> = [];
  while (attacking) {
    for (const probe of [
      { expected: canonical.skill, path: "skills/example/SKILL.md" },
      {
        expected: canonical.openai,
        path: "skills/example/agents/openai.yaml",
      },
      { expected: canonical.icon, path: "skills/example/assets/icon.png" },
    ]) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each read races the same adversarial filesystem transition.
        const value = await readStableRegularFile(root, probe.path, 65_536);
        accepted.push({ expected: probe.expected, value });
      } catch {
        // Fail-closed rejection is expected while the hostile writer owns the path.
      }
    }
  }
  await attacker;
  return {
    accepted,
    canonicalAfterAttack: await readStableRegularFile(
      root,
      "skills/example/SKILL.md",
      65_536,
    ),
    canonicalSkill: canonical.skill,
  };
}

export {
  assertPinnedFixtureContent,
  assertPinnedProvenance,
  pinnedFixture,
  rejectsMetadata,
  runAncestorSwapProbe,
  writeSkill,
};
