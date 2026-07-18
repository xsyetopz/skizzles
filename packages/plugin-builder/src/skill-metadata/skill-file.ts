import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  SkillMetadataError,
  type SkillMetadataRecord,
} from "./contract.ts";
import {
  assertExactKeys,
  boundedString,
  decodeMetadataText,
} from "./text-contract.ts";
import { parseStrictYamlObject } from "./yaml-contract.ts";

const FRONTMATTER_KEYS = ["description", "name"] as const;
const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "\n---\n";

function validateSkillFile(record: SkillMetadataRecord): string {
  const text = decodeMetadataText(record.skill);
  if (!text.startsWith(FRONTMATTER_OPEN)) {
    throw new SkillMetadataError(
      `${record.skill.relativePath}: must start with YAML frontmatter at byte 0.`,
    );
  }
  const closingOffset = text.indexOf(
    FRONTMATTER_CLOSE,
    FRONTMATTER_OPEN.length,
  );
  if (closingOffset < 0) {
    throw new SkillMetadataError(
      `${record.skill.relativePath}: frontmatter must end with an exact --- line.`,
    );
  }
  const frontmatter = text.slice(FRONTMATTER_OPEN.length, closingOffset);
  const body = text.slice(closingOffset + FRONTMATTER_CLOSE.length);
  const value = parseStrictYamlObject(frontmatter, record.skill.relativePath);
  assertExactKeys(
    value,
    FRONTMATTER_KEYS,
    record.skill.relativePath,
    "frontmatter",
  );
  const name = boundedString(
    value["name"],
    record.skill.relativePath,
    "name",
    SKILL_NAME_MAX_LENGTH,
  );
  boundedString(
    value["description"],
    record.skill.relativePath,
    "description",
    SKILL_DESCRIPTION_MAX_LENGTH,
  );
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillMetadataError(
      `${record.skill.relativePath}: name must use canonical kebab-case.`,
    );
  }
  if (name !== record.directoryName) {
    throw new SkillMetadataError(
      `${record.skill.relativePath}: name must match skill directory ${record.directoryName}.`,
    );
  }
  if (body.trim().length === 0) {
    throw new SkillMetadataError(
      `${record.skill.relativePath}: skill body must be nonempty.`,
    );
  }
  return name;
}

export { validateSkillFile };
