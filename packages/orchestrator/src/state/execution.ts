import { exactKeys, isRecord, nonempty, stringArray } from "../codec.ts";
import { type Digest, digestBytes, digestValue } from "../digest.ts";
import { isNormalizedRequest, type NormalizedRequest } from "../intent.ts";
import { isRepositoryContext, type RepositoryContext } from "../repository.ts";

export type RiskClass = "low" | "medium" | "high";
export type ExecutionEventKind = "action" | "retry" | "causal-failure";
export type ExecutionTerminationKind = "failed" | "cancelled";

export interface ExecutionLimits {
  readonly actions: number;
  readonly retries: number;
  readonly repeatedCausalFailures: number;
  readonly wallClockMs: number;
}

export interface ExecutionBudgets {
  readonly low: ExecutionLimits;
  readonly medium: ExecutionLimits;
  readonly high: ExecutionLimits;
}

export interface ClockPort {
  now(): unknown;
}

export interface CompletionAuthorityPort {
  verify(input: {
    readonly executionId: Digest;
    readonly request: NormalizedRequest;
    readonly repository: RepositoryContext;
    readonly contractId: string;
    readonly requiredChecks: readonly string[];
  }): unknown | Promise<unknown>;
}

export interface ExecutionSession {
  readonly executionId: Digest;
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly treeDigest: Digest;
  readonly riskClass: RiskClass;
  readonly actions: number;
  readonly retries: number;
  readonly causalFailures: Readonly<Record<string, number>>;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly version: number;
  readonly state: "active";
}

export interface CompletionEvidence {
  readonly executionId: Digest;
  readonly contractId: string;
  readonly evidenceDigest: Digest;
  readonly completedAtMs: number;
}

export type ExecutionStartResult =
  | { readonly status: "accepted"; readonly execution: ExecutionSession }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_EXECUTION_INPUT"
        | "EXECUTION_ALREADY_EXISTS"
        | "EXECUTION_EXHAUSTED"
        | "CLOCK_REJECTED";
    };

export type ExecutionRecordResult =
  | { readonly status: "accepted"; readonly execution: ExecutionSession }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_EXECUTION_EVENT"
        | "EXECUTION_STALE"
        | "EXECUTION_SEALED"
        | "EXECUTION_EXHAUSTED"
        | "CLOCK_REJECTED";
    };

export type ExecutionCompletionResult =
  | { readonly status: "completed"; readonly evidence: CompletionEvidence }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_EXECUTION_COMPLETION"
        | "EXECUTION_STALE"
        | "EXECUTION_SEALED"
        | "EXECUTION_EXHAUSTED"
        | "COMPLETION_CONTRACT_REJECTED"
        | "CLOCK_REJECTED";
    };

export type ExecutionTerminationResult =
  | {
      readonly status: "terminated";
      readonly kind: ExecutionTerminationKind;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_EXECUTION_TERMINATION"
        | "EXECUTION_STALE"
        | "EXECUTION_SEALED"
        | "EXECUTION_EXHAUSTED";
    };

interface ConsumedBudget {
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly limits: ExecutionLimits;
  readonly riskClass: RiskClass;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  actions: number;
  retries: number;
  causalFailures: Readonly<Record<string, number>>;
  exhausted: boolean;
}

interface ActiveRecord {
  readonly key: string;
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly limits: ExecutionLimits;
  current: ExecutionSession;
  state:
    | "active"
    | "verifying"
    | "sealed"
    | "exhausted"
    | ExecutionTerminationKind;
}

const sessions = new WeakSet<object>();

export function isExecutionSession(value: unknown): value is ExecutionSession {
  return isRecord(value) && sessions.has(value);
}

export class ExecutionBudgetController {
  private sequence = 0;
  private readonly records = new Map<Digest, ActiveRecord>();
  private readonly keys = new Set<string>();
  private readonly consumed = new Map<string, ConsumedBudget>();
  private readonly clock: ClockPort;
  private readonly authority: CompletionAuthorityPort;
  private readonly budgets: ExecutionBudgets;
  private readonly contractId: string;
  private readonly requiredChecks: readonly string[];

  constructor(
    clock: ClockPort,
    authority: CompletionAuthorityPort,
    budgets: ExecutionBudgets,
    contractId: string,
    requiredChecks: readonly string[],
  ) {
    this.clock = clock;
    this.authority = authority;
    this.budgets = budgets;
    this.contractId = contractId;
    this.requiredChecks = requiredChecks;
  }

  start(input: unknown): ExecutionStartResult {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["request", "repository"]) &&
        isNormalizedRequest(input.request) &&
        isRepositoryContext(input.repository)
      ) ||
      input.request.intentDigest !== input.repository.requestDigest
    ) {
      return { status: "rejected", code: "INVALID_EXECUTION_INPUT" };
    }
    const key = `${input.request.intentDigest}\u0000${input.repository.contextDigest}`;
    if (this.keys.has(key)) {
      return { status: "rejected", code: "EXECUTION_ALREADY_EXISTS" };
    }
    const now = readClock(this.clock);
    if (now === undefined)
      return { status: "rejected", code: "CLOCK_REJECTED" };
    let budget = this.consumed.get(key);
    if (budget === undefined) {
      const riskClass = riskFor(input.request);
      const limits = this.budgets[riskClass];
      budget = {
        request: input.request,
        repository: input.repository,
        limits,
        riskClass,
        startedAtMs: now,
        deadlineMs: now + limits.wallClockMs,
        actions: 0,
        retries: 0,
        causalFailures: Object.freeze({}),
        exhausted: false,
      };
      this.consumed.set(key, budget);
    }
    if (budget.exhausted || now > budget.deadlineMs) {
      budget.exhausted = true;
      return { status: "rejected", code: "EXECUTION_EXHAUSTED" };
    }
    this.sequence += 1;
    const executionId = digestValue({ key, sequence: this.sequence, now });
    const current = createSession({
      executionId,
      requestDigest: input.request.intentDigest,
      repositoryId: input.repository.repositoryId,
      treeDigest: input.repository.treeDigest,
      riskClass: budget.riskClass,
      actions: budget.actions,
      retries: budget.retries,
      causalFailures: budget.causalFailures,
      startedAtMs: budget.startedAtMs,
      deadlineMs: budget.deadlineMs,
      version: 0,
    });
    this.keys.add(key);
    this.records.set(executionId, {
      key,
      request: budget.request,
      repository: budget.repository,
      limits: budget.limits,
      current,
      state: "active",
    });
    return { status: "accepted", execution: current };
  }

  record(input: unknown): ExecutionRecordResult {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["execution", "kind"], ["causalFailureId"]) &&
        isExecutionSession(input.execution) &&
        isEventKind(input.kind)
      ) ||
      (input.kind === "causal-failure") !==
        Object.hasOwn(input, "causalFailureId") ||
      (input.kind === "causal-failure" && !nonempty(input.causalFailureId, 256))
    ) {
      return { status: "rejected", code: "INVALID_EXECUTION_EVENT" };
    }
    const record = this.records.get(input.execution.executionId);
    const available = this.available(record, input.execution);
    if (available !== undefined) {
      return { status: "rejected", code: available };
    }
    if (record === undefined)
      return { status: "rejected", code: "EXECUTION_STALE" };
    const now = readClock(this.clock);
    if (now === undefined)
      return { status: "rejected", code: "CLOCK_REJECTED" };
    if (now > record.current.deadlineMs) {
      record.state = "exhausted";
      this.exhaust(record.key);
      return { status: "rejected", code: "EXECUTION_EXHAUSTED" };
    }
    const failures = { ...record.current.causalFailures };
    let actions = record.current.actions;
    let retries = record.current.retries;
    if (input.kind === "action") actions += 1;
    if (input.kind === "retry") retries += 1;
    if (
      input.kind === "causal-failure" &&
      typeof input.causalFailureId === "string"
    ) {
      failures[input.causalFailureId] =
        (failures[input.causalFailureId] ?? 0) + 1;
    }
    if (
      actions > record.limits.actions ||
      retries > record.limits.retries ||
      Object.values(failures).some(
        (count) => count > record.limits.repeatedCausalFailures,
      )
    ) {
      record.state = "exhausted";
      this.exhaust(record.key);
      return { status: "rejected", code: "EXECUTION_EXHAUSTED" };
    }
    const next = createSession({
      ...record.current,
      actions,
      retries,
      causalFailures: failures,
      version: record.current.version + 1,
    });
    record.current = next;
    this.consume(record.key, next);
    return { status: "accepted", execution: next };
  }

  terminate(input: unknown): ExecutionTerminationResult {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["execution", "kind"]) &&
        isExecutionSession(input.execution) &&
        isTerminationKind(input.kind)
      )
    ) {
      return { status: "rejected", code: "INVALID_EXECUTION_TERMINATION" };
    }
    const record = this.records.get(input.execution.executionId);
    const available = this.available(record, input.execution);
    if (available !== undefined) {
      return { status: "rejected", code: available };
    }
    if (record === undefined) {
      return { status: "rejected", code: "EXECUTION_STALE" };
    }
    const budget = this.consumed.get(record.key);
    if (budget === undefined) {
      return { status: "rejected", code: "EXECUTION_STALE" };
    }
    this.consume(record.key, record.current);
    budget.retries += 1;
    if (budget.retries > budget.limits.retries) {
      budget.exhausted = true;
    }
    record.state = input.kind;
    this.keys.delete(record.key);
    return { status: "terminated", kind: input.kind };
  }

  async complete(input: unknown): Promise<ExecutionCompletionResult> {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["execution"]) &&
        isExecutionSession(input.execution)
      )
    ) {
      return { status: "rejected", code: "INVALID_EXECUTION_COMPLETION" };
    }
    const record = this.records.get(input.execution.executionId);
    const available = this.available(record, input.execution);
    if (available !== undefined) {
      return { status: "rejected", code: available };
    }
    if (record === undefined)
      return { status: "rejected", code: "EXECUTION_STALE" };
    const before = readClock(this.clock);
    if (before === undefined)
      return { status: "rejected", code: "CLOCK_REJECTED" };
    if (before > record.current.deadlineMs) {
      record.state = "exhausted";
      this.exhaust(record.key);
      return { status: "rejected", code: "EXECUTION_EXHAUSTED" };
    }
    record.state = "verifying";
    let raw: unknown;
    try {
      raw = await this.authority.verify(
        Object.freeze({
          executionId: record.current.executionId,
          request: record.request,
          repository: record.repository,
          contractId: this.contractId,
          requiredChecks: this.requiredChecks,
        }),
      );
    } catch {
      record.state = "active";
      return { status: "rejected", code: "COMPLETION_CONTRACT_REJECTED" };
    }
    const after = readClock(this.clock);
    if (after === undefined) {
      record.state = "exhausted";
      this.exhaust(record.key);
      return { status: "rejected", code: "CLOCK_REJECTED" };
    }
    if (after > record.current.deadlineMs) {
      record.state = "exhausted";
      this.exhaust(record.key);
      return { status: "rejected", code: "EXECUTION_EXHAUSTED" };
    }
    const evidenceDigest = parseCompletion(
      raw,
      record,
      this.contractId,
      this.requiredChecks,
    );
    if (evidenceDigest === undefined) {
      record.state = "active";
      return { status: "rejected", code: "COMPLETION_CONTRACT_REJECTED" };
    }
    record.state = "sealed";
    return {
      status: "completed",
      evidence: Object.freeze({
        executionId: record.current.executionId,
        contractId: this.contractId,
        evidenceDigest,
        completedAtMs: after,
      }),
    };
  }

  private available(
    record: ActiveRecord | undefined,
    session: ExecutionSession,
  ):
    | "EXECUTION_STALE"
    | "EXECUTION_SEALED"
    | "EXECUTION_EXHAUSTED"
    | undefined {
    if (record === undefined || record.current !== session) {
      if (record?.state === "sealed") return "EXECUTION_SEALED";
      if (record?.state === "exhausted") return "EXECUTION_EXHAUSTED";
      return "EXECUTION_STALE";
    }
    if (record.state === "sealed") return "EXECUTION_SEALED";
    if (record.state === "exhausted") return "EXECUTION_EXHAUSTED";
    if (record.state !== "active") return "EXECUTION_STALE";
    return absent();
  }

  private consume(key: string, session: ExecutionSession): void {
    const budget = this.consumed.get(key);
    if (budget === undefined) return;
    budget.actions = session.actions;
    budget.retries = session.retries;
    budget.causalFailures = session.causalFailures;
  }

  private exhaust(key: string): void {
    const budget = this.consumed.get(key);
    if (budget !== undefined) budget.exhausted = true;
  }
}

export function parseExecutionBudgets(
  value: unknown,
): ExecutionBudgets | undefined {
  if (!(isRecord(value) && exactKeys(value, ["low", "medium", "high"]))) return;
  const low = parseLimits(value.low);
  const medium = parseLimits(value.medium);
  const high = parseLimits(value.high);
  if (low === undefined || medium === undefined || high === undefined) return;
  return Object.freeze({ low, medium, high });
}

function parseLimits(value: unknown): ExecutionLimits | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, [
        "actions",
        "retries",
        "repeatedCausalFailures",
        "wallClockMs",
      ])
    )
  )
    return;
  const fields = [
    value.actions,
    value.retries,
    value.repeatedCausalFailures,
    value.wallClockMs,
  ];
  if (fields.some((item) => !positiveInteger(item))) return;
  if (
    !(
      positiveInteger(value.actions) &&
      positiveInteger(value.retries) &&
      positiveInteger(value.repeatedCausalFailures) &&
      positiveInteger(value.wallClockMs)
    )
  )
    return;
  return Object.freeze({
    actions: value.actions,
    retries: value.retries,
    repeatedCausalFailures: value.repeatedCausalFailures,
    wallClockMs: value.wallClockMs,
  });
}

function createSession(
  input: Omit<ExecutionSession, "state">,
): ExecutionSession {
  const session: ExecutionSession = Object.freeze({
    ...input,
    causalFailures: Object.freeze({ ...input.causalFailures }),
    state: "active",
  });
  sessions.add(session);
  return session;
}

function readClock(clock: ClockPort): number | undefined {
  let result: number | undefined;
  try {
    const value = clock.now();
    result =
      Number.isSafeInteger(value) && typeof value === "number" && value >= 0
        ? value
        : undefined;
  } catch {}
  return result;
}

function riskFor(request: NormalizedRequest): RiskClass {
  if (
    request.canonical.securitySeverity === "high" ||
    request.canonical.securitySeverity === "critical"
  )
    return "high";
  if (request.canonical.securitySeverity === "medium") return "medium";
  return "low";
}

function isEventKind(value: unknown): value is ExecutionEventKind {
  return value === "action" || value === "retry" || value === "causal-failure";
}

function isTerminationKind(value: unknown): value is ExecutionTerminationKind {
  return value === "failed" || value === "cancelled";
}

function parseCompletion(
  raw: unknown,
  record: ActiveRecord,
  contractId: string,
  requiredChecks: readonly string[],
): Digest | undefined {
  if (
    !(
      isRecord(raw) &&
      exactKeys(raw, [
        "executionId",
        "requestDigest",
        "repositoryId",
        "treeDigest",
        "contractId",
        "checks",
      ])
    ) ||
    raw.executionId !== record.current.executionId ||
    raw.requestDigest !== record.current.requestDigest ||
    raw.repositoryId !== record.current.repositoryId ||
    raw.treeDigest !== record.current.treeDigest ||
    raw.contractId !== contractId ||
    !Array.isArray(raw.checks) ||
    raw.checks.length !== requiredChecks.length
  )
    return;
  const ids = new Set<string>();
  const material: { readonly id: string; readonly evidenceDigest: Digest }[] =
    [];
  for (const check of raw.checks) {
    if (
      !(
        isRecord(check) && exactKeys(check, ["id", "passed", "evidenceBytes"])
      ) ||
      typeof check.id !== "string" ||
      !requiredChecks.includes(check.id) ||
      ids.has(check.id) ||
      check.passed !== true
    )
      return;
    const evidence = bytes(check.evidenceBytes);
    if (evidence === undefined) return;
    ids.add(check.id);
    material.push({
      id: check.id,
      evidenceDigest: digestBytes(Uint8Array.from(evidence)),
    });
  }
  material.sort((left, right) => left.id.localeCompare(right.id));
  return ids.size === requiredChecks.length ? digestValue(material) : undefined;
}

function bytes(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_048_576)
    return;
  const result: number[] = [];
  for (const item of value) {
    if (!Number.isInteger(item) || item < 0 || item > 255) return;
    result.push(item);
  }
  return Object.freeze(result);
}

export function parseCompletionContract(
  value: unknown,
): { readonly id: string; readonly checks: readonly string[] } | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, ["id", "checks"]) &&
      nonempty(value.id, 128)
    )
  )
    return;
  const checks = stringArray(value.checks);
  if (
    checks === undefined ||
    checks.length < 2 ||
    checks.length > 64 ||
    checks.some((check) => !nonempty(check, 128)) ||
    new Set(checks).size !== checks.length
  )
    return;
  return Object.freeze({
    id: value.id,
    checks: Object.freeze([...checks].sort()),
  });
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function absent(): undefined {}
