/** Stable synchronization API; implementations are split by transaction domain. */

export { compareManifests } from "./comparison.ts";
export type {
  ApplySyncOptions,
  InitializeSyncOptions,
  PreviewSyncOptions,
  RecoverSyncOptions,
  SyncChange,
  SyncComparison,
  SyncConflict,
  SyncDirection,
  SyncGitOptions,
  SyncIdentity,
  SyncPreview,
} from "./contract.ts";
export {
  initializeSyncBaseline,
  previewSync,
  publicSyncPreview,
} from "./preview.ts";
export { applySync } from "./transaction/apply.ts";
export { recoverSyncTransactions } from "./transaction/recovery.ts";
