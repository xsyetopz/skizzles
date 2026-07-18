/**
 * Compatibility façade for the archived-owner reaper.
 *
 * The implementation lives in `reaper-domain.ts`; this module preserves the
 * historical import path used by the CLI and downstream callers.
 */
export type { ReaperOptions, ReaperResult } from "./reaper-domain.ts";
// biome-ignore lint/performance/noBarrelFile: This export preserves the public legacy import path.
export {
  readThreadState,
  reapArchivedOwners,
  validateThreadsSchema,
} from "./reaper-domain.ts";
