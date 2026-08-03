import type { LabMetadata, PersistedLabRuntime } from "../storage/records";

export type LabRuntime = PersistedLabRuntime & { metadata: LabMetadata };
