import type { SyncFile } from "../files.ts";

export type SyncDirection = "push" | "pull";

export interface SyncChange {
  path: string;
  action: "upsert" | "delete";
  file?: SyncFile;
}

export interface SyncConflict {
  path: string;
  baseline?: SyncFile;
  source?: SyncFile;
  target?: SyncFile;
}

export interface SyncComparison {
  changes: SyncChange[];
  conflicts: SyncConflict[];
}

export interface SyncIdentity {
  stateRoot: string;
  labId: string;
}

export interface PreviewSyncOptions extends SyncIdentity {
  direction: SyncDirection;
  sourceRoot: string;
  targetRoot: string;
  now?: Date;
  ttlMs?: number;
  maxEntries?: number;
}

export interface SyncPreview extends SyncComparison {
  token: string;
  expiresAt: string;
  sourceDigest: string;
  targetDigest: string;
}

export interface ApplySyncOptions extends PreviewSyncOptions {
  token: string;
  /** Must establish immediately before mutation that the lab is safe to change. */
  idleGuard: () => boolean | undefined | Promise<boolean | undefined>;
}

export interface RecoverSyncOptions extends SyncIdentity {
  /** Canonicalized before use; journals targeting any other root are rejected. */
  allowedTargetRoots: string[];
}

export interface BaselineFile {
  version: 1;
  files: Record<string, SyncFile>;
}

export interface StoredPreview extends SyncPreview {
  version: 1;
  labId: string;
  direction: SyncDirection;
  sourceRoot: string;
  targetRoot: string;
  baselineDigest: string;
  missingTargetDirectories: string[];
  deleteParentDirectories: DirectoryIdentity[];
  binding: string;
  expectedTargets: Record<string, SyncFile | null>;
}

export interface DirectoryIdentity {
  path: string;
  device: string;
  inode: string;
}

export interface BackupRecord {
  path: string;
  existed: boolean;
  kind?: "file" | "symlink";
  mode?: number;
  backup?: string;
  publication?: string;
  original: SyncFile | null;
}

export interface SyncJournal {
  version: 1;
  state: "preparing" | "prepared" | "applied" | "rolledBack" | "committed";
  previewToken: string;
  previewBinding: string;
  targetRoot: string;
  baselinePath: string;
  newBaseline: BaselineFile;
  backups: BackupRecord[];
  createdDirectories: DirectoryIdentity[];
  creatingDirectory?: string;
  deleteParentDirectories: DirectoryIdentity[];
  mutatedPaths: string[];
  appliedStates: Record<string, SyncFile | null>;
}
