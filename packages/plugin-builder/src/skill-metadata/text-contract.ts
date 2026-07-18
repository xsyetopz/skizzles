import { SkillMetadataError, type SkillMetadataFile } from "./contract.ts";

const DEFAULT_IGNORABLE_CHARACTER = /\p{Default_Ignorable_Code_Point}/u;
const BODY_ALLOWED_CONTROLS = new Set([9, 10]);
const C0_CONTROL_MAX = 31;
const DELETE_CONTROL = 127;
const C1_CONTROL_MAX = 159;

function decodeMetadataText(file: SkillMetadataFile): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    throw new SkillMetadataError(`${file.relativePath}: must be valid UTF-8.`);
  }
  if (text.includes("\r")) {
    throw new SkillMetadataError(
      `${file.relativePath}: must use LF line endings.`,
    );
  }
  if (text.includes("\0")) {
    throw new SkillMetadataError(
      `${file.relativePath}: must not contain NUL bytes.`,
    );
  }
  return text;
}

function boundedString(
  value: unknown,
  path: string,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    [...value].length > maximumLength ||
    containsControlCharacter(value) ||
    DEFAULT_IGNORABLE_CHARACTER.test(value)
  ) {
    throw new SkillMetadataError(
      `${path}: ${field} must be a nonempty bounded string.`,
    );
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      (code <= C0_CONTROL_MAX ||
        (code >= DELETE_CONTROL && code <= C1_CONTROL_MAX))
    ) {
      return true;
    }
  }
  return false;
}

function containsUnsafeBodyCharacter(value: string): boolean {
  if (DEFAULT_IGNORABLE_CHARACTER.test(value)) {
    return true;
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      !BODY_ALLOWED_CONTROLS.has(code) &&
      (code <= C0_CONTROL_MAX ||
        (code >= DELETE_CONTROL && code <= C1_CONTROL_MAX))
    ) {
      return true;
    }
  }
  return false;
}

function objectValue(
  value: unknown,
  path: string,
  field: string,
): Record<string, unknown> {
  if (!isObject(value)) {
    throw new SkillMetadataError(`${path}: ${field} must be a mapping.`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  label: string,
  allowSubset = false,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...allowedKeys].sort();
  const unknown = actual.find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    if (!allowSubset) {
      throw new SkillMetadataError(
        `${path}: ${label} keys must be exactly: ${allowed.join(", ")}.`,
      );
    }
    throw new SkillMetadataError(`${path}: ${label} contains unsupported key.`);
  }
  if (!(allowSubset || sameStrings(actual, allowed))) {
    throw new SkillMetadataError(
      `${path}: ${label} keys must be exactly: ${allowed.join(", ")}.`,
    );
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export {
  assertExactKeys,
  boundedString,
  containsUnsafeBodyCharacter,
  decodeMetadataText,
  objectValue,
  sameStrings,
};
