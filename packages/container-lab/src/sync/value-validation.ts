import {
  MAX_SYNC_FILE_BYTES,
  type SyncFile,
  safeRelativePath,
} from "../files.ts";
import type {
  DirectoryIdentity,
  SyncChange,
  SyncConflict,
} from "./contract.ts";

export interface JsonObject {
  [key: string]: unknown;
  action?: unknown;
  appliedStates?: unknown;
  backup?: unknown;
  backups?: unknown;
  baselineDigest?: unknown;
  baselinePath?: unknown;
  binding?: unknown;
  changes?: unknown;
  conflicts?: unknown;
  createdDirectories?: unknown;
  creatingDirectory?: unknown;
  deleteParentDirectories?: unknown;
  device?: unknown;
  direction?: unknown;
  existed?: unknown;
  expectedTargets?: unknown;
  expiresAt?: unknown;
  file?: unknown;
  files?: unknown;
  kind?: unknown;
  inode?: unknown;
  labId?: unknown;
  mode?: unknown;
  missingTargetDirectories?: unknown;
  mutatedPaths?: unknown;
  newBaseline?: unknown;
  original?: unknown;
  path?: unknown;
  publication?: unknown;
  previewBinding?: unknown;
  previewToken?: unknown;
  sha256?: unknown;
  size?: unknown;
  sourceDigest?: unknown;
  sourceRoot?: unknown;
  state?: unknown;
  targetDigest?: unknown;
  targetRoot?: unknown;
  token?: unknown;
  version?: unknown;
}
export const TOKEN = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export function parseFileRecord(
  value: unknown,
  label: string,
): Record<string, SyncFile> {
  const object = objectValue(value, label);
  const result = Object.create(null) as Record<string, SyncFile>;
  for (const key of Object.keys(object).sort()) {
    const relative = syncPath(key, `${label} path`);
    result[relative] = parseSyncFile(
      object[key],
      relative,
      `${label} ${relative}`,
    );
  }
  return result;
}

export function parseNullableFileRecord(
  value: unknown,
  label: string,
): Record<string, SyncFile | null> {
  const object = objectValue(value, label);
  const result = Object.create(null) as Record<string, SyncFile | null>;
  for (const key of Object.keys(object).sort()) {
    const relative = syncPath(key, `${label} path`);
    result[relative] =
      object[key] === null
        ? null
        : parseSyncFile(object[key], relative, `${label} ${relative}`);
  }
  return result;
}

export function parseDirectoryIdentities(
  value: unknown,
  label: string,
): DirectoryIdentity[] {
  if (!Array.isArray(value)) {
    invalid(label);
  }
  const identities = value.map((entry, index) => {
    const object = exactObject(entry, `${label} ${index}`, [
      "path",
      "device",
      "inode",
    ]);
    return {
      path: syncPath(object.path, `${label} ${index} path`),
      device: decimalString(object.device, `${label} ${index} device`),
      inode: decimalString(object.inode, `${label} ${index} inode`),
    };
  });
  assertSortedUnique(
    identities.map((entry) => entry.path),
    label,
  );
  return identities;
}
export function parseSyncFile(
  value: unknown,
  relative: string,
  label: string,
): SyncFile {
  const object = exactObject(value, label, [
    "path",
    "kind",
    "sha256",
    "size",
    "mode",
  ]);
  if (object.path !== relative) {
    invalid(`${label} path`);
  }
  const kind = object.kind;
  if (kind !== "file" && kind !== "symlink") {
    invalid(`${label} kind`);
  }
  const size = object.size;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_SYNC_FILE_BYTES
  ) {
    invalid(`${label} size`);
  }
  return {
    path: relative,
    kind,
    sha256: digest(object.sha256, `${label} digest`),
    size,
    mode: parseMode(object.mode, `${label} mode`),
  };
}

export function parsePathArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    invalid(label);
  }
  const paths = value.map((entry, index) =>
    syncPath(entry, `${label} ${index}`),
  );
  assertSortedUnique(paths, label);
  return paths;
}

export function assertDisjointPaths(
  changes: SyncChange[],
  conflicts: SyncConflict[],
): void {
  const changed = new Set(changes.map((item) => item.path));
  if (conflicts.some((item) => changed.has(item.path))) {
    invalid("preview change and conflict paths");
  }
}

export function assertSortedUnique(values: string[], label: string): void {
  const sorted = [...values].sort();
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => value !== sorted[index])
  ) {
    invalid(label);
  }
}

export function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

export function exactObject(
  value: unknown,
  label: string,
  required: string[],
  optional: string[] = [],
): JsonObject {
  const object = objectValue(value, label);
  assertExactKeys(object, label, required, optional);
  return object;
}

export function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(label);
  }
  return value as JsonObject;
}

export function assertExactKeys(
  object: JsonObject,
  label: string,
  required: string[],
  optional: string[] = [],
): void {
  const keys = Object.keys(object);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !(required.includes(key) || optional.includes(key)))
  ) {
    invalid(`${label} fields`);
  }
}

export function syncPath(value: unknown, label: string): string {
  const relative = requiredString(value, label);
  try {
    return safeRelativePath(relative);
  } catch {
    invalid(label);
  }
}

export function parseMode(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0o777
  ) {
    invalid(label);
  }
  return value;
}

export function parseDirection(value: unknown): "push" | "pull" {
  if (value !== "push" && value !== "pull") {
    invalid("preview direction");
  }
  return value;
}

export function digest(value: unknown, label: string): string {
  return stringMatching(value, SHA256, label);
}

export function decimalString(value: unknown, label: string): string {
  return stringMatching(value, DECIMAL, label);
}

export function stringMatching(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  const string = requiredString(value, label);
  if (!pattern.test(string)) {
    invalid(label);
  }
  return string;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(label);
  }
  return value;
}

export function parseIsoDate(value: unknown, label: string): string {
  const string = requiredString(value, label);
  const milliseconds = Date.parse(string);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== string
  ) {
    invalid(label);
  }
  return string;
}

export function invalid(label: string): never {
  throw new Error(`Invalid ${label}`);
}
