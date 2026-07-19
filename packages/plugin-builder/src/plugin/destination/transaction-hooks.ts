import type { ClaimPoint } from "./claim.ts";

type Checkpoint =
  | ClaimPoint
  | "lock-created"
  | "owner-ready"
  | "initial-journal-ready"
  | "stage-created"
  | "stage-journal-ready"
  | "stage-disposal-renamed"
  | "stage-disposal-remove"
  | "backup-journal-ready"
  | "backup-ready"
  | "backup-validated"
  | "backup-renamed"
  | "backup-disposal-ready"
  | "backup-disposal-renamed"
  | "backup-disposal-remove"
  | "destination-ready"
  | "destination-renamed"
  | "committed-journal-ready"
  | "committed"
  | "lock-disposal-ready"
  | "lock-disposal-renamed"
  | "lock-disposal-remove"
  | "lock-disposal-journal"
  | "lock-disposal-owner";

interface DestinationTransactionHooks {
  afterParentCreated?: (path: string) => Promise<void> | void;
  beforeBackupCleanup?: (path: string) => Promise<void> | void;
  beforeLockCleanup?: (path: string) => Promise<void> | void;
  beforeLockRemovalRename?: () => Promise<void> | void;
  checkpoint?: (checkpoint: Checkpoint, path?: string) => Promise<void> | void;
}

export type { Checkpoint, DestinationTransactionHooks };
