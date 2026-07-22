import type { NormalizedRequest } from "../../admission/intent.ts";
import type { RepositoryContext } from "../../admission/repository.ts";
import { type Digest, digestValue } from "../../digest.ts";
import { snapshotRecord } from "../session/snapshot.ts";
import type {
  TaskContext,
  TaskContextResetHandle,
  TaskContextResetResult,
} from "./contract.ts";
import { advanceReset } from "./execution.ts";
import type {
  CheckpointRestorationFailureCode,
  EpochBinding,
  ResetRecord,
  ResetSettlement,
  TaskResetEnvironment,
} from "./state.ts";

const maximumIdentityLength = 128;

export interface TaskAdmission {
  readonly taskEpochDigest: Digest;
  readonly context: TaskContext;
  readonly active: () => boolean;
  readonly release: () => void;
}

interface ResetHandleBinding {
  readonly record: ResetRecord;
  readonly handle: TaskContextResetHandle;
}

export class TaskContextController {
  private readonly environment: TaskResetEnvironment;
  private readonly contexts = new WeakMap<object, EpochBinding>();
  private readonly resetHandles = new WeakMap<object, ResetHandleBinding>();
  private sequence = 0;
  private resetSequence = 0;
  private current: EpochBinding | null = null;
  private reset: ResetRecord | null = null;

  constructor(environment: TaskResetEnvironment) {
    this.environment = environment;
  }

  contextFor(
    request: NormalizedRequest,
    repository: RepositoryContext,
  ): TaskContext | undefined {
    const current = this.current;
    if (current !== null) {
      if (!sameBindings(current, request, repository)) return;
      return current.accepting ? current.context : undefined;
    }
    const created = this.createEpoch(request, repository, true);
    this.current = created;
    return created.context;
  }

  admitContext(value: unknown): TaskAdmission | undefined {
    if (typeof value !== "object" || value === null) return;
    const epoch = this.contexts.get(value);
    return this.admitBinding(epoch);
  }

  admitEpoch(taskEpochDigest: Digest): TaskAdmission | undefined {
    const current = this.current;
    if (current?.taskEpochDigest !== taskEpochDigest) return;
    return this.admitBinding(current);
  }

  retireEpoch(taskEpochDigest: Digest): void {
    const current = this.current;
    if (current?.taskEpochDigest === taskEpochDigest) current.accepting = false;
  }

  async resetContext(input: unknown): Promise<TaskContextResetResult> {
    const parsed = snapshotRecord(input, ["context", "checkpointId", "reason"]);
    if (
      parsed === undefined ||
      parsed["reason"] !== "context-renewal" ||
      !validIdentity(parsed["checkpointId"])
    ) {
      return rejected("INVALID_CONTEXT_RESET_INPUT");
    }
    if (this.reset !== null) return rejected("TASK_CONTEXT_RESETTING");
    if (typeof parsed["context"] !== "object" || parsed["context"] === null) {
      return rejected("INVALID_CONTEXT_RESET_INPUT");
    }
    const previous = this.contexts.get(parsed["context"]);
    if (
      previous === undefined ||
      previous !== this.current ||
      previous.resetting
    ) {
      return rejected("TASK_CONTEXT_STALE");
    }
    previous.accepting = false;
    previous.resetting = true;
    this.resetSequence += 1;
    const record: ResetRecord = {
      previous,
      checkpointId: parsed["checkpointId"],
      interruptId: digestValue({
        taskEpochDigest: previous.taskEpochDigest,
        resetSequence: this.resetSequence,
      }),
      stage: "interrupt",
      handle: null,
      interruptReceiptDigest: null,
      settlement: null,
      restoration: null,
      next: null,
      temporaryStateDigest: null,
    };
    this.reset = record;
    return await this.drive(record);
  }

  async resumeContextReset(input: unknown): Promise<TaskContextResetResult> {
    const parsed = snapshotRecord(input, ["handle"]);
    if (
      parsed === undefined ||
      typeof parsed["handle"] !== "object" ||
      parsed["handle"] === null
    ) {
      return rejected("INVALID_CONTEXT_RESET_INPUT");
    }
    const binding = this.resetHandles.get(parsed["handle"]);
    if (
      binding === undefined ||
      binding.record !== this.reset ||
      binding.record.handle !== binding.handle
    ) {
      return rejected("TASK_CONTEXT_STALE");
    }
    this.resetHandles.delete(binding.handle);
    binding.record.handle = null;
    return await this.drive(binding.record);
  }

  private admitBinding(
    epoch: EpochBinding | undefined,
  ): TaskAdmission | undefined {
    if (
      epoch === undefined ||
      epoch !== this.current ||
      !epoch.accepting ||
      epoch.resetting
    ) {
      return;
    }
    epoch.inFlight += 1;
    let released = false;
    return Object.freeze({
      taskEpochDigest: epoch.taskEpochDigest,
      context: epoch.context,
      active: () => epoch.accepting && !epoch.resetting && !released,
      release: () => {
        if (released) return;
        released = true;
        epoch.inFlight -= 1;
      },
    });
  }

  private async drive(record: ResetRecord): Promise<TaskContextResetResult> {
    const advanced = await advanceReset(
      this.environment,
      record,
      (request, repository) => this.createEpoch(request, repository, false),
    );
    if (advanced.status === "pending") {
      return this.pending(record, advanced.stage, advanced.checkpointCode);
    }
    advanced.next.accepting = true;
    this.current = advanced.next;
    this.reset = null;
    return {
      status: "ready",
      context: advanced.next.context,
      bootstrap: advanced.bootstrap,
      receipt: advanced.receipt,
    };
  }

  private pending(
    record: ResetRecord,
    stage: "interrupt" | "recovery" | "cleanup" | "checkpoint" | "discovery",
    checkpointCode?: CheckpointRestorationFailureCode,
  ): TaskContextResetResult {
    const handle = Object.freeze({
      schema: "skizzles.task-context-reset/v1" as const,
    });
    record.handle = handle;
    this.resetHandles.set(handle, { record, handle });
    let code:
      | "INTERRUPT_UNCONFIRMED"
      | "PUBLICATION_UNCERTAIN"
      | "CLEANUP_FAILED"
      | "CHECKPOINT_UNAVAILABLE"
      | "CHECKPOINT_DRIFTED"
      | "DISCOVERY_INCOMPLETE";
    if (stage === "interrupt") code = "INTERRUPT_UNCONFIRMED";
    else if (stage === "recovery") code = "PUBLICATION_UNCERTAIN";
    else if (stage === "cleanup") code = "CLEANUP_FAILED";
    else if (stage === "discovery") code = "DISCOVERY_INCOMPLETE";
    else if (
      checkpointCode === "TREE_DRIFT" ||
      checkpointCode === "VERIFIER_DRIFT" ||
      checkpointCode === "CHECKPOINT_SCOPE_MISMATCH"
    ) {
      code = "CHECKPOINT_DRIFTED";
    } else code = "CHECKPOINT_UNAVAILABLE";
    return { status: "reset-pending", stage, code, handle };
  }

  private createEpoch(
    request: NormalizedRequest,
    repository: RepositoryContext,
    accepting: boolean,
  ): EpochBinding {
    this.sequence += 1;
    const taskEpochDigest = digestValue({
      taskId: this.environment.taskId,
      repositoryId: repository.repositoryId,
      rootIdentity: this.environment.rootIdentity,
      contextDigest: repository.contextDigest,
      sequence: this.sequence,
    });
    const context: TaskContext = Object.freeze({
      schema: "skizzles.task-context/v1" as const,
      taskEpochDigest,
    });
    const binding: EpochBinding = {
      context,
      taskId: this.environment.taskId,
      rootIdentity: this.environment.rootIdentity,
      request,
      repository,
      taskEpochDigest,
      accepting,
      resetting: false,
      inFlight: 0,
    };
    this.contexts.set(context, binding);
    return binding;
  }
}

function sameBindings(
  epoch: EpochBinding,
  request: NormalizedRequest,
  repository: RepositoryContext,
): boolean {
  return (
    epoch.request.intentDigest === request.intentDigest &&
    epoch.repository.repositoryId === repository.repositoryId &&
    epoch.repository.requestDigest === repository.requestDigest &&
    epoch.repository.treeDigest === repository.treeDigest &&
    epoch.repository.contextDigest === repository.contextDigest
  );
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumIdentityLength &&
    !value.includes("\0")
  );
}

function rejected(
  code:
    | "INVALID_CONTEXT_RESET_INPUT"
    | "TASK_CONTEXT_STALE"
    | "TASK_CONTEXT_RESETTING",
): TaskContextResetResult {
  return { status: "rejected", code };
}

export type { ResetSettlement, TaskResetEnvironment };
