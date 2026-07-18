import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_METADATA_KEY_MAX_LENGTH,
  SKILL_METADATA_KEY_PATTERN,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  SKILL_OPTIONAL_TEXT_MAX_LENGTH,
  SkillMetadataError,
  type SkillMetadataRecord,
} from "./contract.ts";
import {
  assertExactKeys,
  boundedString,
  decodeMetadataText,
} from "./text-contract.ts";
import { parseStrictYamlObject } from "./yaml-contract.ts";

const FRONTMATTER_KEYS = [
  "allowed-tools",
  "description",
  "license",
  "metadata",
  "name",
] as const;
const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "\n---\n";
const NON_VISIBLE_HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/gu;
const VISIBLE_INSTRUCTION_CHARACTER = /[\p{L}\p{N}\p{S}]/u;

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
    true,
  );
  if (!("name" in value && "description" in value)) {
    throw new SkillMetadataError(
      `${record.skill.relativePath}: frontmatter requires name and description.`,
    );
  }
  const name = boundedString(
    value["name"],
    record.skill.relativePath,
    "name",
    SKILL_NAME_MAX_LENGTH,
  );
  const description = boundedString(
    value["description"],
    record.skill.relativePath,
    "description",
    SKILL_DESCRIPTION_MAX_LENGTH,
  );
  const normalizedDescription = description.normalize("NFKC");
  if (
    normalizedDescription.includes("<") ||
    normalizedDescription.includes(">")
  ) {
    throw new SkillMetadataError(
      `${record.skill.relativePath}: description must not contain angle-bracket markup.`,
    );
  }
  validateOptionalFrontmatter(value, record.skill.relativePath);
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
  if (!hasVisibleSkillBody(body)) {
    throw new SkillMetadataError(
      `${record.skill.relativePath}: skill body must contain visible instructional content.`,
    );
  }
  return name;
}

function validateOptionalFrontmatter(
  value: Record<string, unknown>,
  path: string,
): void {
  for (const key of ["license", "allowed-tools"] as const) {
    if (key in value) {
      boundedString(value[key], path, key, SKILL_OPTIONAL_TEXT_MAX_LENGTH);
    }
  }
  if ("metadata" in value) {
    const metadata = value["metadata"];
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata)
    ) {
      throw new SkillMetadataError(
        `${path}: metadata must be a string mapping.`,
      );
    }
    for (const [key, metadataValue] of Object.entries(metadata)) {
      if (
        key.length > SKILL_METADATA_KEY_MAX_LENGTH ||
        !SKILL_METADATA_KEY_PATTERN.test(key) ||
        typeof metadataValue !== "string"
      ) {
        throw new SkillMetadataError(
          `${path}: metadata must be a string mapping.`,
        );
      }
      boundedString(
        metadataValue,
        path,
        `metadata.${key}`,
        SKILL_OPTIONAL_TEXT_MAX_LENGTH,
      );
    }
  }
}

function hasVisibleSkillBody(body: string): boolean {
  const withoutComments = body
    .normalize("NFKC")
    .replaceAll(NON_VISIBLE_HTML_COMMENT, "");
  return VISIBLE_INSTRUCTION_CHARACTER.test(withoutComments);
}

export { validateSkillFile };
