import type { NormalizedRequest } from "../../admission/intent.ts";
import type { RepositoryContext } from "../../admission/repository.ts";
import type {
  TaskCheckpointRestoration,
  TaskCheckpointRestorationReceipt,
} from "../../checkpoint.ts";
import type { Digest } from "../../digest.ts";
import type { DiscoveryResult } from "../../state/discovery.ts";
import type {
  TaskContext,
  TaskContextResetHandle,
  TaskRuntimeInterruptAuthorityPort,
} from "./contract.ts";

export interface EpochBinding {
  readonly context: TaskContext;
  readonly taskId: string;
  readonly rootIdentity: string;
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly taskEpochDigest: Digest;
  accepting: boolean;
  resetting: boolean;
  inFlight: number;
}

export type ResetSettlement =
  | {
      readonly status: "settled";
      readonly workflowCleanupDigest: Digest;
      readonly publicationOutcome:
        | "none"
        | "not-published"
        | "recovered-old"
        | "recovered-new"
        | "committed";
    }
  | {
      readonly status: "pending";
      readonly stage: "recovery" | "cleanup";
    };

export interface TaskResetEnvironment {
  readonly taskId: string;
  readonly rootIdentity: string;
  readonly discoveryRoot: string;
  readonly runtime: TaskRuntimeInterruptAuthorityPort;
  readonly settle: (taskEpochDigest: Digest) => Promise<ResetSettlement>;
  readonly invalidate: (taskEpochDigest: Digest) => Digest;
  readonly restore: (input: unknown) => Promise<TaskCheckpointRestoration>;
  readonly discover: (input: unknown) => Promise<DiscoveryResult>;
}

export interface ResetRecord {
  readonly previous: EpochBinding;
  readonly checkpointId: string;
  readonly interruptId: Digest;
  stage: "interrupt" | "settle" | "checkpoint" | "discovery";
  handle: TaskContextResetHandle | null;
  interruptReceiptDigest: Digest | null;
  settlement: Extract<ResetSettlement, { status: "settled" }> | null;
  restoration: TaskCheckpointRestorationReceipt | null;
  next: EpochBinding | null;
  temporaryStateDigest: Digest | null;
}

export type CheckpointRestorationFailureCode = Exclude<
  TaskCheckpointRestoration,
  { readonly status: "restored" }
>["code"];
