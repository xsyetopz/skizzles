import type { Digest } from "../../digest.ts";
import type { DiscoverySnapshot } from "../../state/discovery.ts";

export interface TaskContext {
  readonly schema: "skizzles.task-context/v1";
  readonly taskEpochDigest: Digest;
}

export interface TaskContextResetHandle {
  readonly schema: "skizzles.task-context-reset/v1";
}

export interface TaskRuntimeInterruptRequest {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly requestDigest: Digest;
  readonly treeDigest: Digest;
  readonly taskEpochDigest: Digest;
  readonly interruptId: Digest;
  readonly reason: "context-renewal";
}

export interface TaskRuntimeInterruptAuthorityPort {
  readonly timeoutMilliseconds: number;
  readonly interrupt: (
    input: TaskRuntimeInterruptRequest,
  ) => unknown | Promise<unknown>;
}

export interface TaskContextBootstrap {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly taskEpochDigest: Digest;
  readonly checkpointId: string;
  readonly checkpointEvidenceDigest: Digest;
  readonly discovery: DiscoverySnapshot;
  readonly inheritHistory: false;
  readonly bootstrapDigest: Digest;
}

export interface TaskContextResetReceipt {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly previousEpochDigest: Digest;
  readonly nextEpochDigest: Digest;
  readonly checkpointId: string;
  readonly checkpointEvidenceDigest: Digest;
  readonly interruptReceiptDigest: Digest;
  readonly workflowCleanupDigest: Digest;
  readonly publicationOutcome:
    | "none"
    | "not-published"
    | "recovered-old"
    | "recovered-new"
    | "committed";
  readonly restorationDigest: Digest;
  readonly discoveryDigest: Digest;
  readonly temporaryStateDigest: Digest;
  readonly receiptDigest: Digest;
}

export type TaskContextResetStage =
  | "interrupt"
  | "recovery"
  | "cleanup"
  | "checkpoint"
  | "discovery";

export type TaskContextResetResult =
  | {
      readonly status: "ready";
      readonly context: TaskContext;
      readonly bootstrap: TaskContextBootstrap;
      readonly receipt: TaskContextResetReceipt;
    }
  | {
      readonly status: "reset-pending";
      readonly stage: TaskContextResetStage;
      readonly code:
        | "INTERRUPT_UNCONFIRMED"
        | "PUBLICATION_UNCERTAIN"
        | "CLEANUP_FAILED"
        | "CHECKPOINT_UNAVAILABLE"
        | "CHECKPOINT_DRIFTED"
        | "DISCOVERY_INCOMPLETE";
      readonly handle: TaskContextResetHandle;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_CONTEXT_RESET_INPUT"
        | "TASK_CONTEXT_STALE"
        | "TASK_CONTEXT_RESETTING";
    };

export type TaskContextResetResumeResult = TaskContextResetResult;
