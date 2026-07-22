export type ReflexionDigest = `sha256:${string}`;

export interface ReflexionOrigin {
  readonly taskId: string;
  readonly runId: string;
}

export interface ReflexionFailure {
  readonly kind: string;
  readonly summary: string;
  readonly evidenceDigests: readonly ReflexionDigest[];
}

export interface ReflexionCritique {
  readonly cause: string;
  readonly correction: string;
  readonly prevention: string;
}

export interface ExternalSkillDirectoryReference {
  readonly kind: "external-skill-directory";
  readonly access: "read-only";
  readonly directoryId: string;
  readonly relativeSkillPath: string;
  readonly revisionDigest: ReflexionDigest;
}

export interface ReflexionFailureRecordInput {
  readonly origin: ReflexionOrigin;
  readonly failure: ReflexionFailure;
  readonly critique: ReflexionCritique;
  readonly skillReferences: readonly ExternalSkillDirectoryReference[];
}

export interface ReflexionFailureRecord {
  readonly schema: "skizzles.reflexion-memory/failure-record";
  readonly domain: "reflexion-failure-memory";
  readonly version: 1;
  readonly origin: ReflexionOrigin;
  readonly failure: ReflexionFailure;
  readonly critique: ReflexionCritique;
  readonly skillReferences: readonly ExternalSkillDirectoryReference[];
  readonly recordDigest: ReflexionDigest;
}

export interface ReflexionMemoryScope {
  readonly currentTaskId: string;
  readonly currentRunId: string;
}

export interface ReflexionMemorySnapshot {
  readonly schema: "skizzles.reflexion-memory/snapshot";
  readonly domain: "reflexion-failure-memory";
  readonly version: 1;
  readonly scope: ReflexionMemoryScope;
  readonly records: readonly ReflexionFailureRecord[];
  readonly snapshotDigest: ReflexionDigest;
}

export interface ReflexionPersistenceReceipt {
  readonly schema: "skizzles.reflexion-memory/persistence-receipt";
  readonly domain: "reflexion-failure-memory";
  readonly version: 1;
  readonly disposition: "stored" | "duplicate";
  readonly recordDigest: ReflexionDigest;
  readonly persistenceRevisionDigest: ReflexionDigest;
}

export interface ReflexionMemoryPersistenceAuthority {
  readonly storeFailureRecordIfAbsent: (
    record: ReflexionFailureRecord,
  ) => Promise<unknown>;
}

export interface ReflexionMemoryRecordSource {
  readonly readFailureRecords: () => Promise<unknown>;
}

export interface ReflexionMemoryRecorder {
  readonly recordFailure: (
    input: ReflexionFailureRecordInput,
  ) => Promise<ReflexionPersistenceReceipt>;
}

export interface ReflexionMemoryQuery {
  readonly snapshot: (
    scope: ReflexionMemoryScope,
  ) => Promise<ReflexionMemorySnapshot>;
}

export type ReflexionLocalDatabaseCreationResult =
  | Readonly<{
      status: "created";
      query: ReflexionMemoryQuery;
      recorder: ReflexionMemoryRecorder;
    }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_LOCAL_DATABASE_CONFIG" | "LOCAL_DATABASE_UNAVAILABLE";
    }>;
