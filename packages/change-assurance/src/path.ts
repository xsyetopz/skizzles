import { posix } from "node:path";

export function normalizeTargetPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    posix.isAbsolute(value)
  ) {
    return;
  }
  const normalized = posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return;
  }
  return normalized;
}
