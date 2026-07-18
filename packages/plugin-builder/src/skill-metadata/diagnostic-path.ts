import { isAbsolute } from "node:path";

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const MAX_DIAGNOSTIC_PATH_LENGTH = 512;
const REDACTED_SKILL_PATH = "<redacted-skill-path>";
const DEFAULT_IGNORABLE_CHARACTER = /\p{Default_Ignorable_Code_Point}/u;
const C0_CONTROL_MAX = 31;
const DELETE_CONTROL = 127;
const C1_CONTROL_MAX = 159;

function containsUnsafePathCharacter(value: string): boolean {
  if (DEFAULT_IGNORABLE_CHARACTER.test(value)) {
    return true;
  }
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

function diagnosticPath(value: string): string {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.length > MAX_DIAGNOSTIC_PATH_LENGTH ||
    value.includes("\\") ||
    containsUnsafePathCharacter(value) ||
    isAbsolute(value) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !SAFE_PATH_SEGMENT.test(segment),
    )
  ) {
    return REDACTED_SKILL_PATH;
  }
  return value;
}

export { containsUnsafePathCharacter, diagnosticPath };
