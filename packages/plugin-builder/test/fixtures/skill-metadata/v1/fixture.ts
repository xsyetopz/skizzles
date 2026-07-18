// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { expect } from "bun:test";
import {
  APPROVED_MCP_ENDPOINTS,
  SKILL_METADATA_CONTRACT_PROVENANCE,
  SKILL_METADATA_CONTRACT_VERSION,
} from "../../../../src/skill-metadata/official-contract-v1.ts";
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
  expect(provenance.sources).toEqual(
    SKILL_METADATA_CONTRACT_PROVENANCE.artifacts,
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.approvedMcpEndpoints).toEqual(APPROVED_MCP_ENDPOINTS);
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.networkLimitation).toBe(
    SKILL_METADATA_CONTRACT_PROVENANCE.networkLimitation,
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: assertion helper is called only from the pinned-provenance test.
  expect(provenance.filesystemLimitation).toBe(
    SKILL_METADATA_CONTRACT_PROVENANCE.filesystemLimitation,
  );
}

export { assertPinnedProvenance, pinnedFixture, rejectsMetadata, writeSkill };
