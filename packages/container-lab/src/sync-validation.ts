import path from "node:path";
import {
  MAX_SYNC_FILE_BYTES,
  type SyncFile,
  safeRelativePath,
} from "./files.ts";
import type {
  BackupRecord,
  BaselineFile,
  DirectoryIdentity,
  StoredPreview,
  SyncChange,
  SyncConflict,
  SyncJournal,
} from "./sync-contract.ts";

interface JsonObject {
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

const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export function parseBaselineFile(value: unknown): BaselineFile {
  const object = exactObject(value, "synchronization baseline", [
    "version",
    "files",
  ]);
  if (object.version !== 1) {
    invalid("synchronization baseline version");
  }
  return { version: 1, files: parseFileRecord(object.files, "baseline files") };
}

export function parseStoredPreview(value: unknown): StoredPreview {
  const object = exactObject(value, "synchronization preview", [
    "version",
    "token",
    "expiresAt",
    "sourceDigest",
    "targetDigest",
    "changes",
    "conflicts",
    "labId",
    "direction",
    "sourceRoot",
    "targetRoot",
    "baselineDigest",
    "missingTargetDirectories",
    "deleteParentDirectories",
    "binding",
    "expectedTargets",
  ]);
  if (object.version !== 1) {
    invalid("synchronization preview version");
  }
  const token = stringMatching(object.token, TOKEN, "preview token");
  const expiresAt = parseIsoDate(object.expiresAt, "preview expiry");
  const sourceDigest = digest(object.sourceDigest, "preview source digest");
  const targetDigest = digest(object.targetDigest, "preview target digest");
  const baselineDigest = digest(
    object.baselineDigest,
    "preview baseline digest",
  );
  const binding = digest(object.binding, "preview binding");
  const labId = requiredString(object.labId, "preview lab id");
  const direction = parseDirection(object.direction);
  const sourceRoot = requiredString(object.sourceRoot, "preview source root");
  const targetRoot = requiredString(object.targetRoot, "preview target root");
  const changes = parseChanges(object.changes);
  const conflicts = parseConflicts(object.conflicts);
  assertDisjointPaths(changes, conflicts);
  const expectedTargets = parseExpectedTargets(object.expectedTargets, changes);
  const missingTargetDirectories = parsePathArray(
    object.missingTargetDirectories,
    "preview missing target directories",
  );
  const deleteParentDirectories = parseDirectoryIdentities(
    object.deleteParentDirectories,
    "preview delete parent directories",
  );
  if (
    missingTargetDirectories.some(
      (directory) =>
        !changes.some((change) => change.path.startsWith(`${directory}/`)),
    )
  ) {
    invalid("preview missing target directory provenance");
  }
  if (
    JSON.stringify(deleteParentDirectories.map((entry) => entry.path)) !==
    JSON.stringify(expectedDeleteParentPaths(changes))
  ) {
    invalid("preview delete parent directory provenance");
  }
  return {
    version: 1,
    token,
    expiresAt,
    sourceDigest,
    targetDigest,
    baselineDigest,
    binding,
    labId,
    direction,
    sourceRoot,
    targetRoot,
    changes,
    conflicts,
    expectedTargets,
    missingTargetDirectories,
    deleteParentDirectories,
  };
}

export function parseSyncJournal(value: unknown): SyncJournal {
  const object = exactObject(
    value,
    "synchronization journal",
    [
      "version",
      "state",
      "previewToken",
      "previewBinding",
      "targetRoot",
      "baselinePath",
      "newBaseline",
      "backups",
      "createdDirectories",
      "deleteParentDirectories",
      "mutatedPaths",
      "appliedStates",
    ],
    ["creatingDirectory"],
  );
  if (object.version !== 1) {
    invalid("synchronization journal version");
  }
  if (
    object.state !== "preparing" &&
    object.state !== "prepared" &&
    object.state !== "applied" &&
    object.state !== "rolledBack" &&
    object.state !== "committed"
  ) {
    invalid("synchronization journal state");
  }
  const backups = parseBackups(object.backups);
  const paths = backups.map((item) => item.path);
  const { createdDirectories, creatingDirectory, deleteParentDirectories } =
    parseJournalDirectories(object, paths, object.state);
  const mutatedPaths = parsePathArray(object.mutatedPaths, "mutated paths");
  if (object.state === "preparing" && mutatedPaths.length > 0) {
    invalid("preparing synchronization journal mutations");
  }
  for (const mutated of mutatedPaths) {
    if (!paths.includes(mutated)) {
      invalid("journal mutated path provenance");
    }
  }
  const appliedStates = parseNullableFileRecord(
    object.appliedStates,
    "journal applied states",
  );
  if (!sameStringSet(Object.keys(appliedStates), paths)) {
    invalid("journal applied state coverage");
  }
  for (const backup of backups) {
    const intended = appliedStates[backup.path];
    if (intended === undefined) {
      invalid("journal applied state coverage");
    }
    if (!backup.publication) {
      invalid("journal publication provenance");
    }
  }
  return {
    version: 1,
    state: object.state,
    previewToken: stringMatching(
      object.previewToken,
      TOKEN,
      "journal preview token",
    ),
    previewBinding: digest(object.previewBinding, "journal preview binding"),
    targetRoot: requiredString(object.targetRoot, "journal target root"),
    baselinePath: requiredString(object.baselinePath, "journal baseline path"),
    newBaseline: parseBaselineFile(object.newBaseline),
    backups,
    createdDirectories,
    ...(creatingDirectory === undefined ? {} : { creatingDirectory }),
    deleteParentDirectories,
    mutatedPaths,
    appliedStates,
  };
}

function parseJournalDirectories(
  object: JsonObject,
  paths: string[],
  state: SyncJournal["state"],
): {
  createdDirectories: DirectoryIdentity[];
  creatingDirectory?: string;
  deleteParentDirectories: DirectoryIdentity[];
} {
  const createdDirectories = parseDirectoryIdentities(
    object.createdDirectories,
    "journal created directories",
  );
  if (
    createdDirectories.some(
      (directory) =>
        !paths.some((relative) => relative.startsWith(`${directory.path}/`)),
    )
  ) {
    invalid("journal created directory provenance");
  }
  if (state === "preparing" && createdDirectories.length > 0) {
    invalid("preparing synchronization journal directories");
  }
  const creatingDirectory =
    object.creatingDirectory === undefined
      ? undefined
      : syncPath(object.creatingDirectory, "journal creating directory");
  if (
    creatingDirectory !== undefined &&
    (state !== "prepared" ||
      createdDirectories.some((entry) => entry.path === creatingDirectory) ||
      !paths.some((relative) => relative.startsWith(`${creatingDirectory}/`)))
  ) {
    invalid("journal creating directory provenance");
  }
  return {
    createdDirectories,
    ...(creatingDirectory === undefined ? {} : { creatingDirectory }),
    deleteParentDirectories: parseDirectoryIdentities(
      object.deleteParentDirectories,
      "journal delete parent directories",
    ),
  };
}

function parseChanges(value: unknown): SyncChange[] {
  if (!Array.isArray(value)) {
    invalid("preview changes");
  }
  const changes = value.map((entry, index) => {
    const object = objectValue(entry, `preview change ${index}`);
    const action = object.action;
    if (action !== "upsert" && action !== "delete") {
      invalid(`preview change ${index} action`);
    }
    const keys =
      action === "upsert" ? ["path", "action", "file"] : ["path", "action"];
    assertExactKeys(object, `preview change ${index}`, keys);
    const relative = syncPath(object.path, `preview change ${index} path`);
    const change: SyncChange =
      action === "upsert"
        ? {
            path: relative,
            action,
            file: parseSyncFile(
              object.file,
              relative,
              `preview change ${index} file`,
            ),
          }
        : { path: relative, action };
    return change;
  });
  assertSortedUnique(
    changes.map((item) => item.path),
    "preview change paths",
  );
  return changes;
}

function parseConflicts(value: unknown): SyncConflict[] {
  if (!Array.isArray(value)) {
    invalid("preview conflicts");
  }
  const conflicts = value.map((entry, index) => {
    const object = objectValue(entry, `preview conflict ${index}`);
    assertExactKeys(
      object,
      `preview conflict ${index}`,
      ["path"],
      ["baseline", "source", "target"],
    );
    const relative = syncPath(object.path, `preview conflict ${index} path`);
    const result: SyncConflict = { path: relative };
    for (const side of ["baseline", "source", "target"] as const) {
      if (object[side] !== undefined) {
        result[side] = parseSyncFile(
          object[side],
          relative,
          `preview conflict ${index} ${side}`,
        );
      }
    }
    return result;
  });
  assertSortedUnique(
    conflicts.map((item) => item.path),
    "preview conflict paths",
  );
  return conflicts;
}

function parseExpectedTargets(
  value: unknown,
  changes: SyncChange[],
): Record<string, SyncFile | null> {
  const expected = parseNullableFileRecord(value, "preview expected targets");
  if (
    !sameStringSet(
      Object.keys(expected),
      changes.map((item) => item.path),
    )
  ) {
    invalid("preview expected target coverage");
  }
  return expected;
}

function parseBackups(value: unknown): BackupRecord[] {
  if (!Array.isArray(value)) {
    invalid("journal backups");
  }
  const backups = value.map((entry, index) => {
    const object = objectValue(entry, `journal backup ${index}`);
    const existed = object.existed;
    if (typeof existed !== "boolean") {
      invalid(`journal backup ${index} existence`);
    }
    const required = existed
      ? ["path", "existed", "kind", "mode", "backup", "original"]
      : ["path", "existed", "original"];
    assertExactKeys(object, `journal backup ${index}`, [
      ...required,
      "publication",
    ]);
    const relative = syncPath(object.path, `journal backup ${index} path`);
    const publication = requiredString(
      object.publication,
      `journal backup ${index} publication`,
    );
    if (!existed) {
      if (object.original !== null) {
        invalid(`journal backup ${index} original`);
      }
      const record: BackupRecord = {
        path: relative,
        existed: false,
        original: null,
        publication,
      };
      return record;
    }
    const kind = object.kind;
    if (kind !== "file" && kind !== "symlink") {
      invalid(`journal backup ${index} kind`);
    }
    const mode = parseMode(object.mode, `journal backup ${index} mode`);
    const original = parseSyncFile(
      object.original,
      relative,
      `journal backup ${index} original`,
    );
    if (original.kind !== kind || original.mode !== mode) {
      invalid(`journal backup ${index} descriptor`);
    }
    const record: BackupRecord = {
      path: relative,
      existed: true,
      kind,
      mode,
      backup: requiredString(object.backup, `journal backup ${index} path`),
      original,
      publication,
    };
    return record;
  });
  assertSortedUnique(
    backups.map((item) => item.path),
    "journal backup paths",
  );
  return backups;
}

function parseFileRecord(
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

function parseNullableFileRecord(
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

function parseDirectoryIdentities(
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

function expectedDeleteParentPaths(changes: SyncChange[]): string[] {
  const parents = new Set<string>();
  for (const change of changes) {
    if (change.action !== "delete") {
      continue;
    }
    const parts = change.path.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index++) {
      parents.add(parts.slice(0, index).join("/"));
    }
  }
  return [...parents].sort();
}

function parseSyncFile(
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

function parsePathArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    invalid(label);
  }
  const paths = value.map((entry, index) =>
    syncPath(entry, `${label} ${index}`),
  );
  assertSortedUnique(paths, label);
  return paths;
}

function assertDisjointPaths(
  changes: SyncChange[],
  conflicts: SyncConflict[],
): void {
  const changed = new Set(changes.map((item) => item.path));
  if (conflicts.some((item) => changed.has(item.path))) {
    invalid("preview change and conflict paths");
  }
}

function assertSortedUnique(values: string[], label: string): void {
  const sorted = [...values].sort();
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => value !== sorted[index])
  ) {
    invalid(label);
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function exactObject(
  value: unknown,
  label: string,
  required: string[],
  optional: string[] = [],
): JsonObject {
  const object = objectValue(value, label);
  assertExactKeys(object, label, required, optional);
  return object;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(label);
  }
  return value as JsonObject;
}

function assertExactKeys(
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

function syncPath(value: unknown, label: string): string {
  const relative = requiredString(value, label);
  try {
    return safeRelativePath(relative);
  } catch {
    invalid(label);
  }
}

function parseMode(value: unknown, label: string): number {
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

function parseDirection(value: unknown): "push" | "pull" {
  if (value !== "push" && value !== "pull") {
    invalid("preview direction");
  }
  return value;
}

function digest(value: unknown, label: string): string {
  return stringMatching(value, SHA256, label);
}

function decimalString(value: unknown, label: string): string {
  return stringMatching(value, DECIMAL, label);
}

function stringMatching(
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(label);
  }
  return value;
}

function parseIsoDate(value: unknown, label: string): string {
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

function invalid(label: string): never {
  throw new Error(`Invalid ${label}`);
}

export function expectedBackupPath(
  backupRoot: string,
  journalId: string,
  index: number,
): string {
  return path.join(backupRoot, journalId, "target", String(index));
}
