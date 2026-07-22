import {
  isTaskCheckpointRestorationReceipt,
  type TaskCheckpointRestorationReceipt,
} from "../../checkpoint.ts";
import { type Digest, digestValue } from "../../digest.ts";
import { isDiscoverySnapshot } from "../../state/discovery.ts";
import type {
  TaskContextBootstrap,
  TaskContextResetReceipt,
} from "./contract.ts";
import { interruptTaskRuntime } from "./interrupt.ts";
import type {
  CheckpointRestorationFailureCode,
  EpochBinding,
  ResetRecord,
  ResetSettlement,
  TaskResetEnvironment,
} from "./state.ts";

export type ResetAdvance =
  | Readonly<{
      status: "pending";
      stage: "interrupt" | "recovery" | "cleanup" | "checkpoint" | "discovery";
      checkpointCode?: CheckpointRestorationFailureCode;
    }>
  | Readonly<{
      status: "ready";
      next: EpochBinding;
      bootstrap: TaskContextBootstrap;
      receipt: TaskContextResetReceipt;
    }>;

export async function advanceReset(
  environment: TaskResetEnvironment,
  record: ResetRecord,
  createEpoch: (
    request: EpochBinding["request"],
    repository: EpochBinding["repository"],
  ) => EpochBinding,
): Promise<ResetAdvance> {
  if (record.stage === "interrupt") {
    if (record.interruptReceiptDigest === null) {
      const interrupted = await interruptTaskRuntime(environment, record);
      if (interrupted === undefined) return pending("interrupt");
      record.interruptReceiptDigest = interrupted;
    }
    if (record.previous.inFlight > 0) return pending("interrupt");
    record.stage = "settle";
  }
  if (record.stage === "settle") {
    if (record.settlement === null) {
      let settlement: ResetSettlement;
      try {
        settlement = await environment.settle(record.previous.taskEpochDigest);
      } catch {
        return pending("recovery");
      }
      if (settlement.status === "pending") return pending(settlement.stage);
      record.settlement = settlement;
    }
    if (record.temporaryStateDigest === null) {
      try {
        record.temporaryStateDigest = environment.invalidate(
          record.previous.taskEpochDigest,
        );
      } catch {
        return pending("cleanup");
      }
    }
    record.stage = "checkpoint";
  }
  if (record.stage === "checkpoint") {
    let restoration: Awaited<ReturnType<TaskResetEnvironment["restore"]>>;
    try {
      restoration = await environment.restore(
        Object.freeze({
          id: record.checkpointId,
          taskId: record.previous.taskId,
          rootIdentity: record.previous.rootIdentity,
          request: record.previous.request,
          repository: record.previous.repository,
        }),
      );
    } catch {
      return pending("checkpoint");
    }
    if (restoration.status !== "restored") {
      return pending("checkpoint", restoration.code);
    }
    if (!validRestoration(record, restoration.receipt)) {
      return pending("checkpoint", "CHECKPOINT_SCOPE_MISMATCH");
    }
    record.restoration = restoration.receipt;
    record.next ??= createEpoch(
      record.previous.request,
      record.previous.repository,
    );
    record.stage = "discovery";
  }
  return await discover(environment, record);
}

async function discover(
  environment: TaskResetEnvironment,
  record: ResetRecord,
): Promise<ResetAdvance> {
  const next = record.next;
  const restoration = record.restoration;
  const settlement = record.settlement;
  const interruptReceiptDigest = record.interruptReceiptDigest;
  const temporaryStateDigest = record.temporaryStateDigest;
  if (
    next === null ||
    restoration === null ||
    settlement === null ||
    interruptReceiptDigest === null ||
    temporaryStateDigest === null
  ) {
    return pending("checkpoint");
  }
  let discovered: Awaited<ReturnType<TaskResetEnvironment["discover"]>>;
  try {
    discovered = await environment.discover(
      Object.freeze({
        request: next.request,
        repository: next.repository,
        root: environment.discoveryRoot,
        taskId: next.taskId,
        taskEpochDigest: next.taskEpochDigest,
      }),
    );
  } catch {
    return pending("discovery");
  }
  if (
    discovered.status !== "accepted" ||
    !validDiscovery(environment, next, discovered.discovery)
  ) {
    return pending("discovery");
  }
  const bootstrapMaterial = {
    taskId: next.taskId,
    repositoryId: next.repository.repositoryId,
    taskEpochDigest: next.taskEpochDigest,
    checkpointId: restoration.checkpointId,
    checkpointEvidenceDigest: restoration.checkpointEvidenceDigest,
    discoveryDigest: discovered.discovery.discoveryDigest,
    inheritHistory: false as const,
  };
  const bootstrap: TaskContextBootstrap = Object.freeze({
    taskId: bootstrapMaterial.taskId,
    repositoryId: bootstrapMaterial.repositoryId,
    taskEpochDigest: bootstrapMaterial.taskEpochDigest,
    checkpointId: bootstrapMaterial.checkpointId,
    checkpointEvidenceDigest: bootstrapMaterial.checkpointEvidenceDigest,
    discovery: discovered.discovery,
    inheritHistory: false,
    bootstrapDigest: digestValue(bootstrapMaterial),
  });
  return Object.freeze({
    status: "ready",
    next,
    bootstrap,
    receipt: createResetReceipt(
      record,
      next,
      bootstrap,
      settlement,
      restoration,
      interruptReceiptDigest,
      temporaryStateDigest,
    ),
  });
}

function validRestoration(
  record: ResetRecord,
  receipt: TaskCheckpointRestorationReceipt,
): boolean {
  const material = {
    checkpointId: record.checkpointId,
    taskId: record.previous.taskId,
    repositoryId: record.previous.repository.repositoryId,
    rootIdentity: record.previous.rootIdentity,
    requestDigest: record.previous.request.intentDigest,
    repositoryTreeDigest: record.previous.repository.treeDigest,
    contextDigest: record.previous.repository.contextDigest,
    checkpointEvidenceDigest: receipt.checkpointEvidenceDigest,
  };
  return (
    isTaskCheckpointRestorationReceipt(receipt) &&
    receipt.checkpointId === material.checkpointId &&
    receipt.taskId === material.taskId &&
    receipt.repositoryId === material.repositoryId &&
    receipt.rootIdentity === material.rootIdentity &&
    receipt.requestDigest === material.requestDigest &&
    receipt.repositoryTreeDigest === material.repositoryTreeDigest &&
    receipt.contextDigest === material.contextDigest &&
    receipt.restorationDigest === digestValue(material)
  );
}

function validDiscovery(
  environment: TaskResetEnvironment,
  next: EpochBinding,
  discovery: unknown,
): discovery is import("../../state/discovery.ts").DiscoverySnapshot {
  return (
    isDiscoverySnapshot(discovery) &&
    discovery.complete &&
    discovery.stoppedBy === null &&
    discovery.repositoryId === next.repository.repositoryId &&
    discovery.requestDigest === next.request.intentDigest &&
    discovery.treeDigest === next.repository.treeDigest &&
    discovery.root === environment.discoveryRoot &&
    discovery.expansion === 0 &&
    discovery.reviewId === null &&
    discovery.taskId === next.taskId &&
    discovery.taskEpochDigest === next.taskEpochDigest
  );
}

function pending(
  stage: Extract<ResetAdvance, { status: "pending" }>["stage"],
  checkpointCode?: CheckpointRestorationFailureCode,
): ResetAdvance {
  return checkpointCode === undefined
    ? Object.freeze({ status: "pending", stage })
    : Object.freeze({ status: "pending", stage, checkpointCode });
}

function createResetReceipt(
  record: ResetRecord,
  next: EpochBinding,
  bootstrap: TaskContextBootstrap,
  settlement: Extract<ResetSettlement, { status: "settled" }>,
  restoration: TaskCheckpointRestorationReceipt,
  interruptReceiptDigest: Digest,
  temporaryStateDigest: Digest,
): TaskContextResetReceipt {
  const material = {
    taskId: next.taskId,
    repositoryId: next.repository.repositoryId,
    previousEpochDigest: record.previous.taskEpochDigest,
    nextEpochDigest: next.taskEpochDigest,
    checkpointId: restoration.checkpointId,
    checkpointEvidenceDigest: restoration.checkpointEvidenceDigest,
    interruptReceiptDigest,
    workflowCleanupDigest: settlement.workflowCleanupDigest,
    publicationOutcome: settlement.publicationOutcome,
    restorationDigest: restoration.restorationDigest,
    discoveryDigest: bootstrap.discovery.discoveryDigest,
    temporaryStateDigest,
  };
  return Object.freeze({ ...material, receiptDigest: digestValue(material) });
}
