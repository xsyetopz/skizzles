import { digestValue } from "../../digest.ts";
import {
  isSchedulerWorkerAuthority,
  issueSchedulerDispatchRequest,
} from "./authority.ts";
import type {
  DependencyScheduler,
  DependencySchedulerCreationResult,
  SchedulerLedgerEntry,
  SchedulerTask,
  SchedulerWorkerAuthority,
  SchedulerWorkerResult,
} from "./contract.ts";
import { type ParsedSchedule, parseSchedule } from "./input.ts";
import {
  issueSchedulerReceipt,
  ledgerEntry,
  verifySchedulerReceipt,
} from "./receipt.ts";

interface SchedulerConfig {
  readonly maximumParallelism: number;
  readonly worker: SchedulerWorkerAuthority;
}

interface DispatchState {
  readonly task: SchedulerTask;
  readonly result: SchedulerWorkerResult;
  readonly dispatchOrdinal: number;
  readonly wave: number;
  readonly prerequisites: readonly `sha256:${string}`[];
}

const schedulers = new WeakSet<object>();

export function createDependencyScheduler(
  input: unknown,
): DependencySchedulerCreationResult {
  const config = parseConfig(input);
  if (config === undefined) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_SCHEDULER_CONFIG",
    });
  }
  const owner = Object.freeze({});
  const executionIds = new Set<string>();
  const requestDigests = new WeakMap<object, `sha256:${string}`>();
  const scheduler: DependencyScheduler = Object.freeze({
    run: (value: unknown) =>
      run(owner, config, executionIds, requestDigests, value),
    verify: (value: unknown) => verify(owner, requestDigests, value),
  });
  schedulers.add(scheduler);
  return Object.freeze({ status: "created", scheduler });
}

export function isDependencyScheduler(
  value: unknown,
): value is DependencyScheduler {
  return typeof value === "object" && value !== null && schedulers.has(value);
}

async function run(
  owner: object,
  config: SchedulerConfig,
  executionIds: Set<string>,
  requestDigests: WeakMap<object, `sha256:${string}`>,
  input: unknown,
) {
  let parsed: ReturnType<typeof parseSchedule>;
  try {
    parsed = parseSchedule(input);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_SCHEDULER_INPUT" as const,
    });
  }
  if (executionIds.has(parsed.request.executionId)) {
    return Object.freeze({
      status: "rejected" as const,
      code: "REPLAY_REJECTED" as const,
    });
  }
  executionIds.add(parsed.request.executionId);
  const entries = await execute(config, parsed);
  const receipt = issueSchedulerReceipt({
    owner,
    request: parsed.request,
    requestDigest: parsed.requestDigest,
    authorityId: config.worker.authorityId,
    maximumParallelism: config.maximumParallelism,
    entries,
  });
  requestDigests.set(receipt, parsed.requestDigest);
  return Object.freeze({ status: "completed" as const, receipt });
}

async function execute(
  config: SchedulerConfig,
  parsed: ParsedSchedule,
): Promise<readonly SchedulerLedgerEntry[]> {
  const pending = new Map(parsed.tasksById);
  const ledger = new Map<string, SchedulerLedgerEntry>();
  let dispatchOrdinal = 0;
  let wave = 0;
  while (pending.size > 0) {
    blockUnsafeDescendants(pending, ledger);
    if (pending.size === 0) break;
    const ready = [...pending.values()]
      .filter((task) =>
        task.dependencies.every(
          (id) => ledger.get(id)?.outcome === "completed",
        ),
      )
      .sort((left, right) => compareText(left.id, right.id));
    if (ready.length === 0)
      throw new Error("validated scheduler graph stalled");
    const batch = compatibleBatch(ready, config.maximumParallelism);
    wave += 1;
    const currentWave = wave;
    const dispatches: Array<
      Readonly<{ task: SchedulerTask; dispatchOrdinal: number }>
    > = [];
    for (const task of batch) {
      pending.delete(task.id);
      dispatchOrdinal += 1;
      dispatches.push(Object.freeze({ task, dispatchOrdinal }));
    }
    const dispatched = dispatches.map(({ task, dispatchOrdinal: ordinal }) =>
      dispatchTask(config, parsed, ledger, task, ordinal, currentWave),
    );
    for (const state of await Promise.all(dispatched)) {
      ledger.set(state.task.id, entryFor(state));
    }
  }
  return Object.freeze([...ledger.values()]);
}

async function dispatchTask(
  config: SchedulerConfig,
  parsed: ParsedSchedule,
  ledger: ReadonlyMap<string, SchedulerLedgerEntry>,
  task: SchedulerTask,
  dispatchOrdinal: number,
  wave: number,
): Promise<DispatchState> {
  const prerequisites = Object.freeze(
    task.dependencies
      .map((id) => ledger.get(id)?.receiptDigest)
      .filter(isDigest),
  );
  const bindingDigest = digestValue({
    executionId: parsed.request.executionId,
    requestDigest: parsed.requestDigest,
    authorityId: config.worker.authorityId,
    task,
    prerequisites,
    dispatchOrdinal,
    wave,
  });
  const result = await config.worker.dispatch(
    issueSchedulerDispatchRequest({
      executionId: parsed.request.executionId,
      task,
      prerequisiteReceiptDigests: prerequisites,
      bindingDigest,
    }),
  );
  return Object.freeze({
    task,
    result,
    dispatchOrdinal,
    wave,
    prerequisites,
  });
}

function blockUnsafeDescendants(
  pending: Map<string, SchedulerTask>,
  ledger: Map<string, SchedulerLedgerEntry>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of [...pending.values()].sort((left, right) =>
      compareText(left.id, right.id),
    )) {
      const failedDependency = task.dependencies.find((id) => {
        const outcome = ledger.get(id)?.outcome;
        return outcome !== undefined && outcome !== "completed";
      });
      if (failedDependency === undefined) continue;
      pending.delete(task.id);
      const prerequisiteReceiptDigests = Object.freeze(
        task.dependencies
          .map((id) => ledger.get(id)?.receiptDigest)
          .filter(isDigest),
      );
      ledger.set(
        task.id,
        ledgerEntry({
          taskId: task.id,
          outcome: "blocked",
          dispatchOrdinal: null,
          wave: null,
          prerequisiteReceiptDigests,
          workerEvidenceDigest: null,
          failureCode: `PREREQUISITE_${failedDependency}_NOT_COMPLETED`,
        }),
      );
      changed = true;
    }
  }
}

function compatibleBatch(
  ready: readonly SchedulerTask[],
  maximumParallelism: number,
): readonly SchedulerTask[] {
  const selected: SchedulerTask[] = [];
  for (const task of ready) {
    if (
      selected.length < maximumParallelism &&
      selected.every((running) => !claimsConflict(task, running))
    ) {
      selected.push(task);
    }
  }
  return Object.freeze(selected);
}

function claimsConflict(left: SchedulerTask, right: SchedulerTask): boolean {
  if (left.repositoryId !== right.repositoryId) return false;
  return left.writePaths.some((leftPath) =>
    right.writePaths.some(
      (rightPath) =>
        leftPath === rightPath ||
        leftPath.startsWith(`${rightPath}/`) ||
        rightPath.startsWith(`${leftPath}/`),
    ),
  );
}

function entryFor(state: DispatchState): SchedulerLedgerEntry {
  const failureCode =
    state.result.status === "failed" ? state.result.code : null;
  return ledgerEntry({
    taskId: state.task.id,
    outcome: state.result.status,
    dispatchOrdinal: state.dispatchOrdinal,
    wave: state.wave,
    prerequisiteReceiptDigests: state.prerequisites,
    workerEvidenceDigest: state.result.evidenceDigest,
    failureCode,
  });
}

function verify(
  owner: object,
  requestDigests: WeakMap<object, `sha256:${string}`>,
  input: unknown,
) {
  if (typeof input !== "object" || input === null) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_RECEIPT" as const,
    });
  }
  const digest = requestDigests.get(input);
  if (digest === undefined || !verifySchedulerReceipt(owner, digest, input)) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_RECEIPT" as const,
    });
  }
  return Object.freeze({
    status: "valid" as const,
    receiptDigest: input.receiptDigest,
  });
}

function parseConfig(input: unknown): SchedulerConfig | undefined {
  if (typeof input !== "object" || input === null) return;
  try {
    if (!Object.isFrozen(input)) return;
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== 2 ||
      !keys.includes("maximumParallelism") ||
      !keys.includes("worker")
    )
      return;
    const maximumParallelism = Object.getOwnPropertyDescriptor(
      input,
      "maximumParallelism",
    );
    const worker = Object.getOwnPropertyDescriptor(input, "worker");
    if (
      maximumParallelism === undefined ||
      worker === undefined ||
      !("value" in maximumParallelism) ||
      !("value" in worker) ||
      !Number.isSafeInteger(maximumParallelism.value) ||
      maximumParallelism.value < 1 ||
      maximumParallelism.value > 64 ||
      !isSchedulerWorkerAuthority(worker.value)
    ) {
      return;
    }
    return Object.freeze({
      maximumParallelism: maximumParallelism.value,
      worker: worker.value,
    });
  } catch {
    return;
  }
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
