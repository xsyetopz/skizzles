import type { Digest } from "../../digest.ts";

export interface SchedulerTask {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly repositoryId: string;
  readonly access: "read-only" | "isolated-write";
  readonly writePaths: readonly string[];
  readonly objectiveDigest: Digest;
}

export interface SchedulerRunRequest {
  readonly version: 1;
  readonly executionId: string;
  readonly tasks: readonly SchedulerTask[];
}

export interface SchedulerDispatchRequest {
  readonly executionId: string;
  readonly task: SchedulerTask;
  readonly prerequisiteReceiptDigests: readonly Digest[];
  readonly bindingDigest: Digest;
}

export type SchedulerWorkerResult =
  | Readonly<{
      status: "completed";
      bindingDigest: Digest;
      evidenceDigest: Digest;
    }>
  | Readonly<{
      status: "failed";
      bindingDigest: Digest;
      code: string;
      evidenceDigest: Digest;
    }>
  | Readonly<{
      status: "cancelled";
      bindingDigest: Digest;
      evidenceDigest: Digest;
    }>;

export interface SchedulerWorkerAuthority {
  readonly authorityId: string;
  readonly dispatch: (
    request: SchedulerDispatchRequest,
  ) => Promise<SchedulerWorkerResult>;
}

export type SchedulerLedgerOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export interface SchedulerLedgerEntry {
  readonly taskId: string;
  readonly outcome: SchedulerLedgerOutcome;
  readonly dispatchOrdinal: number | null;
  readonly wave: number | null;
  readonly prerequisiteReceiptDigests: readonly Digest[];
  readonly workerEvidenceDigest: Digest | null;
  readonly failureCode: string | null;
  readonly receiptDigest: Digest;
}

export interface SchedulerReceipt {
  readonly executionId: string;
  readonly requestDigest: Digest;
  readonly authorityId: string;
  readonly maximumParallelism: number;
  readonly entries: readonly SchedulerLedgerEntry[];
  readonly completedTaskIds: readonly string[];
  readonly failedTaskIds: readonly string[];
  readonly cancelledTaskIds: readonly string[];
  readonly blockedTaskIds: readonly string[];
  readonly receiptDigest: Digest;
}

export type SchedulerRunResult =
  | Readonly<{ status: "completed"; receipt: SchedulerReceipt }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_SCHEDULER_INPUT" | "REPLAY_REJECTED";
    }>;

export interface DependencyScheduler {
  readonly run: (input: unknown) => Promise<SchedulerRunResult>;
  readonly verify: (
    input: unknown,
  ) => Readonly<
    | { status: "valid"; receiptDigest: Digest }
    | { status: "rejected"; code: "INVALID_RECEIPT" }
  >;
}

export type DependencySchedulerCreationResult =
  | Readonly<{ status: "created"; scheduler: DependencyScheduler }>
  | Readonly<{ status: "rejected"; code: "INVALID_SCHEDULER_CONFIG" }>;

export type SchedulerWorkerAuthorityCreationResult =
  | Readonly<{ status: "created"; authority: SchedulerWorkerAuthority }>
  | Readonly<{ status: "rejected"; code: "INVALID_WORKER_AUTHORITY" }>;
