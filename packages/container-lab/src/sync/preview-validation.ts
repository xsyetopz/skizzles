import type { SyncFile } from "../files.ts";
import type {
  BaselineFile,
  StoredPreview,
  SyncChange,
  SyncConflict,
} from "./contract.ts";
import {
  assertDisjointPaths,
  assertExactKeys,
  assertSortedUnique,
  digest,
  exactObject,
  invalid,
  objectValue,
  parseDirection,
  parseDirectoryIdentities,
  parseFileRecord,
  parseIsoDate,
  parseNullableFileRecord,
  parsePathArray,
  parseSyncFile,
  requiredString,
  sameStringSet,
  stringMatching,
  syncPath,
  TOKEN,
} from "./value-validation.ts";

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
