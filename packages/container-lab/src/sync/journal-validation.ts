import path from "node:path";
import type {
  BackupRecord,
  DirectoryIdentity,
  SyncJournal,
} from "./contract.ts";
import { parseBaselineFile } from "./preview-validation.ts";
import {
  assertExactKeys,
  assertSortedUnique,
  digest,
  exactObject,
  invalid,
  type JsonObject,
  objectValue,
  parseDirectoryIdentities,
  parseMode,
  parseNullableFileRecord,
  parsePathArray,
  parseSyncFile,
  requiredString,
  sameStringSet,
  stringMatching,
  syncPath,
  TOKEN,
} from "./value-validation.ts";

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
export function expectedBackupPath(
  backupRoot: string,
  journalId: string,
  index: number,
): string {
  return path.join(backupRoot, journalId, "target", String(index));
}
