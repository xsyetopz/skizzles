import { createHash } from "node:crypto";

export type TaskWorktreeDigest = `sha256:${string}`;

export function digestTaskWorktreeBytes(value: Uint8Array): TaskWorktreeDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestTaskWorktreeValue(value: unknown): TaskWorktreeDigest {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("task-worktree digest values must have string keys");
    }
    return `{${keys
      .map((key) => String(key))
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(dataValue(value, key))}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("task-worktree digest values must be finite JSON data");
}

function dataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError("task-worktree digest values must use data properties");
  }
  return descriptor.value;
}
