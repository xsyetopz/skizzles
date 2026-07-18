import { isAbsolute } from "node:path";

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const MAX_DIAGNOSTIC_PATH_LENGTH = 512;
const REDACTED_SKILL_PATH = "<redacted-skill-path>";

function diagnosticPath(value: string): string {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.length > MAX_DIAGNOSTIC_PATH_LENGTH ||
    value.includes("\\") ||
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

export { diagnosticPath };
