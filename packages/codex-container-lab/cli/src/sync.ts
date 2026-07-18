/** Stable synchronization API; implementations are split by transaction domain. */
export { applySync } from "./sync-apply.ts";
export { compareManifests } from "./sync-comparison.ts";
export type {
  ApplySyncOptions,
  PreviewSyncOptions,
  RecoverSyncOptions,
  SyncChange,
  SyncComparison,
  SyncConflict,
  SyncDirection,
  SyncIdentity,
  SyncPreview,
} from "./sync-contract.ts";
export {
  initializeSyncBaseline,
  previewSync,
  publicSyncPreview,
} from "./sync-preview.ts";
export { recoverSyncTransactions } from "./sync-recovery.ts";
