import {
  isNormalizedRequest,
  type NormalizedRequest,
} from "../admission/intent.ts";
import {
  isRepositoryContext,
  type RepositoryContext,
} from "../admission/repository.ts";
import { exactKeys, isRecord, nonempty } from "../codec.ts";
import { type Digest, digestBytes, digestValue } from "../digest.ts";
import { type DiscoverySnapshot, isDiscoverySnapshot } from "./discovery.ts";
import type { ClockPort } from "./execution.ts";
import {
  isTargetBaseline,
  type TargetBaseline,
  type TargetBaselineManager,
} from "./target.ts";

export type ApprovalState =
  | "planned"
  | "reviewed"
  | "awaiting"
  | "approved"
  | "promoting";

export interface ApprovalChallenge {
  readonly taskId: string;
  readonly principalId: string;
  readonly operation: string;
  readonly requestDigest: Digest;
  readonly treeDigest: Digest;
  readonly baselineDigest: Digest;
  readonly transactionDigest: Digest;
  readonly discoveryDigest: Digest;
  readonly diffDigest: Digest;
  readonly expiresAtMs: number;
  readonly challengeDigest: Digest;
}

export interface ApprovalRequest {
  readonly approvalId: Digest;
  readonly state: ApprovalState;
  readonly version: number;
  readonly taskId: string;
  readonly principalId: string;
  readonly operation: string;
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly treeDigest: Digest;
  readonly baselineDigest: Digest;
  readonly transactionDigest: Digest;
  readonly discoveryDigest: Digest;
  readonly diffBytes: readonly number[];
  readonly diffDigest: Digest;
  readonly challenge: ApprovalChallenge | null;
}

export interface PromotionPermit {
  readonly approvalId: Digest;
  readonly challengeDigest: Digest;
  readonly taskId: string;
  readonly principalId: string;
  readonly operation: string;
  readonly requestDigest: Digest;
  readonly treeDigest: Digest;
  readonly baselineDigest: Digest;
  readonly transactionDigest: Digest;
  readonly discoveryDigest: Digest;
  readonly diffDigest: Digest;
  readonly permitDigest: Digest;
}

export interface ApprovalAuthorityPort {
  authenticate(input: {
    readonly challenge: ApprovalChallenge;
    readonly token: unknown;
  }): unknown | Promise<unknown>;
}

export type ApprovalTransitionResult =
  | { readonly status: "accepted"; readonly approval: ApprovalRequest }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_APPROVAL_INPUT"
        | "APPROVAL_STALE"
        | "APPROVAL_BUSY"
        | "APPROVAL_CANCELLED"
        | "APPROVAL_EXPIRED"
        | "APPROVAL_AUTHORITY_REJECTED"
        | "APPROVAL_DRIFTED"
        | "DISCOVERY_INCOMPLETE";
    };

export type PromotionResult =
  | { readonly status: "promoting"; readonly permit: PromotionPermit }
  | Exclude<ApprovalTransitionResult, { readonly status: "accepted" }>;

export type ApprovalCancelResult =
  | { readonly status: "cancelled" }
  | Exclude<ApprovalTransitionResult, { readonly status: "accepted" }>;

interface ApprovalRecord {
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly baseline: TargetBaseline;
  readonly discovery: DiscoverySnapshot;
  current: ApprovalRequest;
  state: ApprovalState | "authenticating" | "revalidating" | "cancelled";
}

const approvals = new WeakSet<object>();
const permits = new WeakSet<object>();

export function isApprovalRequest(value: unknown): value is ApprovalRequest {
  return isRecord(value) && approvals.has(value);
}

export function isPromotionPermit(value: unknown): value is PromotionPermit {
  return isRecord(value) && permits.has(value);
}

export class ApprovalController {
  private sequence = 0;
  private readonly records = new Map<Digest, ApprovalRecord>();
  private readonly authority: ApprovalAuthorityPort;
  private readonly clock: ClockPort;
  private readonly targets: TargetBaselineManager;
  private readonly ttlMs: number;

  constructor(
    authority: ApprovalAuthorityPort,
    clock: ClockPort,
    targets: TargetBaselineManager,
    ttlMs: number,
  ) {
    this.authority = authority;
    this.clock = clock;
    this.targets = targets;
    this.ttlMs = ttlMs;
  }

  plan(input: unknown): ApprovalTransitionResult {
    const parsed = parsePlan(input);
    if (parsed === undefined)
      return { status: "rejected", code: "INVALID_APPROVAL_INPUT" };
    if (!parsed.discovery.complete)
      return { status: "rejected", code: "DISCOVERY_INCOMPLETE" };
    this.sequence += 1;
    const diffDigest = digestBytes(Uint8Array.from(parsed.diffBytes));
    const approvalId = digestValue({
      taskId: parsed.taskId,
      principalId: parsed.principalId,
      operation: parsed.operation,
      requestDigest: parsed.request.intentDigest,
      repositoryId: parsed.repository.repositoryId,
      treeDigest: parsed.repository.treeDigest,
      baselineDigest: parsed.baseline.baselineDigest,
      transactionDigest: parsed.transactionDigest,
      discoveryDigest: parsed.discovery.discoveryDigest,
      diffDigest,
      sequence: this.sequence,
    });
    const current = createApproval({
      approvalId,
      state: "planned",
      version: 0,
      taskId: parsed.taskId,
      principalId: parsed.principalId,
      operation: parsed.operation,
      requestDigest: parsed.request.intentDigest,
      repositoryId: parsed.repository.repositoryId,
      treeDigest: parsed.repository.treeDigest,
      baselineDigest: parsed.baseline.baselineDigest,
      transactionDigest: parsed.transactionDigest,
      discoveryDigest: parsed.discovery.discoveryDigest,
      diffBytes: parsed.diffBytes,
      diffDigest,
      challenge: null,
    });
    this.records.set(approvalId, {
      request: parsed.request,
      repository: parsed.repository,
      baseline: parsed.baseline,
      discovery: parsed.discovery,
      current,
      state: "planned",
    });
    return { status: "accepted", approval: current };
  }

  review(input: unknown): ApprovalTransitionResult {
    const current = approvalOnly(input);
    if (current === undefined)
      return { status: "rejected", code: "INVALID_APPROVAL_INPUT" };
    const record = this.records.get(current.approvalId);
    const unavailable = availability(record, current, "planned");
    if (unavailable !== undefined) return unavailable;
    if (record === undefined)
      return { status: "rejected", code: "APPROVAL_STALE" };
    const next = transition(current, "reviewed", null);
    record.current = next;
    record.state = "reviewed";
    return { status: "accepted", approval: next };
  }

  awaitApproval(input: unknown): ApprovalTransitionResult {
    const current = approvalOnly(input);
    if (current === undefined)
      return { status: "rejected", code: "INVALID_APPROVAL_INPUT" };
    const record = this.records.get(current.approvalId);
    const unavailable = availability(record, current, "reviewed");
    if (unavailable !== undefined) return unavailable;
    if (record === undefined)
      return { status: "rejected", code: "APPROVAL_STALE" };
    const now = readClock(this.clock);
    if (now === undefined)
      return { status: "rejected", code: "APPROVAL_AUTHORITY_REJECTED" };
    const challengeMaterial = {
      taskId: current.taskId,
      principalId: current.principalId,
      operation: current.operation,
      requestDigest: current.requestDigest,
      treeDigest: current.treeDigest,
      baselineDigest: current.baselineDigest,
      transactionDigest: current.transactionDigest,
      discoveryDigest: current.discoveryDigest,
      diffDigest: current.diffDigest,
      expiresAtMs: now + this.ttlMs,
    };
    const challenge = Object.freeze({
      ...challengeMaterial,
      challengeDigest: digestValue(challengeMaterial),
    });
    const next = transition(current, "awaiting", challenge);
    record.current = next;
    record.state = "awaiting";
    return { status: "accepted", approval: next };
  }

  async approve(input: unknown): Promise<ApprovalTransitionResult> {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["approval", "token"]) &&
        isApprovalRequest(input.approval)
      )
    )
      return { status: "rejected", code: "INVALID_APPROVAL_INPUT" };
    const record = this.records.get(input.approval.approvalId);
    const unavailable = availability(record, input.approval, "awaiting");
    if (unavailable !== undefined) return unavailable;
    if (record === undefined || input.approval.challenge === null)
      return { status: "rejected", code: "APPROVAL_STALE" };
    const now = readClock(this.clock);
    if (now === undefined)
      return { status: "rejected", code: "APPROVAL_AUTHORITY_REJECTED" };
    if (now > input.approval.challenge.expiresAtMs) {
      record.state = "cancelled";
      return { status: "rejected", code: "APPROVAL_EXPIRED" };
    }
    record.state = "authenticating";
    let raw: unknown;
    try {
      raw = await this.authority.authenticate(
        Object.freeze({
          challenge: input.approval.challenge,
          token: input.token,
        }),
      );
    } catch {
      if (record.state === "authenticating") record.state = "awaiting";
      return { status: "rejected", code: "APPROVAL_AUTHORITY_REJECTED" };
    }
    if (currentState(record) === "cancelled")
      return { status: "rejected", code: "APPROVAL_CANCELLED" };
    if (
      currentState(record) !== "authenticating" ||
      record.current !== input.approval
    )
      return { status: "rejected", code: "APPROVAL_STALE" };
    const verifiedAt = readClock(this.clock);
    if (
      verifiedAt === undefined ||
      verifiedAt > input.approval.challenge.expiresAtMs
    ) {
      record.state = "cancelled";
      return { status: "rejected", code: "APPROVAL_EXPIRED" };
    }
    if (!matchesAuthentication(raw, input.approval.challenge, verifiedAt)) {
      record.state = "awaiting";
      return { status: "rejected", code: "APPROVAL_AUTHORITY_REJECTED" };
    }
    const next = transition(
      input.approval,
      "approved",
      input.approval.challenge,
    );
    record.current = next;
    record.state = "approved";
    return { status: "accepted", approval: next };
  }

  async promote(input: unknown): Promise<PromotionResult> {
    const current = approvalOnly(input);
    if (current === undefined)
      return { status: "rejected", code: "INVALID_APPROVAL_INPUT" };
    const record = this.records.get(current.approvalId);
    const unavailable = availability(record, current, "approved");
    if (unavailable !== undefined) return unavailable;
    if (record === undefined || current.challenge === null)
      return { status: "rejected", code: "APPROVAL_STALE" };
    const beforeRevalidation = readClock(this.clock);
    if (beforeRevalidation === undefined) {
      return { status: "rejected", code: "APPROVAL_AUTHORITY_REJECTED" };
    }
    if (beforeRevalidation > current.challenge.expiresAtMs) {
      record.state = "cancelled";
      return { status: "rejected", code: "APPROVAL_EXPIRED" };
    }
    record.state = "revalidating";
    const validation = await this.targets.revalidate(record.baseline);
    if (currentState(record) === "cancelled")
      return { status: "rejected", code: "APPROVAL_CANCELLED" };
    if (currentState(record) !== "revalidating" || record.current !== current)
      return { status: "rejected", code: "APPROVAL_STALE" };
    if (validation.status !== "unchanged") {
      record.state = "cancelled";
      return { status: "rejected", code: "APPROVAL_DRIFTED" };
    }
    const promotedAt = readClock(this.clock);
    if (promotedAt === undefined) {
      record.state = "cancelled";
      return { status: "rejected", code: "APPROVAL_AUTHORITY_REJECTED" };
    }
    if (promotedAt > current.challenge.expiresAtMs) {
      record.state = "cancelled";
      return { status: "rejected", code: "APPROVAL_EXPIRED" };
    }
    const next = transition(current, "promoting", current.challenge);
    record.current = next;
    record.state = "promoting";
    const material = {
      approvalId: current.approvalId,
      challengeDigest: current.challenge.challengeDigest,
      taskId: current.taskId,
      principalId: current.principalId,
      operation: current.operation,
      requestDigest: current.requestDigest,
      treeDigest: current.treeDigest,
      baselineDigest: current.baselineDigest,
      transactionDigest: current.transactionDigest,
      discoveryDigest: current.discoveryDigest,
      diffDigest: current.diffDigest,
    };
    const permit = Object.freeze({
      ...material,
      permitDigest: digestValue(material),
    });
    permits.add(permit);
    return { status: "promoting", permit };
  }

  cancel(input: unknown): ApprovalCancelResult {
    const current = approvalOnly(input);
    if (current === undefined)
      return { status: "rejected", code: "INVALID_APPROVAL_INPUT" };
    const record = this.records.get(current.approvalId);
    if (record === undefined || record.current !== current)
      return { status: "rejected", code: "APPROVAL_STALE" };
    if (record.state === "cancelled")
      return { status: "rejected", code: "APPROVAL_CANCELLED" };
    if (record.state === "promoting")
      return { status: "rejected", code: "APPROVAL_STALE" };
    record.state = "cancelled";
    return { status: "cancelled" };
  }
}

function parsePlan(input: unknown):
  | {
      readonly taskId: string;
      readonly principalId: string;
      readonly operation: string;
      readonly request: NormalizedRequest;
      readonly repository: RepositoryContext;
      readonly baseline: TargetBaseline;
      readonly discovery: DiscoverySnapshot;
      readonly transactionDigest: Digest;
      readonly diffBytes: readonly number[];
    }
  | undefined {
  if (
    !(
      isRecord(input) &&
      exactKeys(input, [
        "taskId",
        "principalId",
        "operation",
        "request",
        "repository",
        "baseline",
        "discovery",
        "transactionDigest",
        "diffBytes",
      ]) &&
      nonempty(input.taskId, 128) &&
      nonempty(input.principalId, 128) &&
      nonempty(input.operation, 128) &&
      isNormalizedRequest(input.request) &&
      isRepositoryContext(input.repository) &&
      isTargetBaseline(input.baseline) &&
      isDiscoverySnapshot(input.discovery) &&
      isDigest(input.transactionDigest)
    ) ||
    input.request.intentDigest !== input.repository.requestDigest ||
    input.baseline.requestDigest !== input.request.intentDigest ||
    input.baseline.repositoryId !== input.repository.repositoryId ||
    input.baseline.treeDigest !== input.repository.treeDigest ||
    input.discovery.requestDigest !== input.request.intentDigest ||
    input.discovery.repositoryId !== input.repository.repositoryId ||
    input.discovery.treeDigest !== input.repository.treeDigest
  )
    return;
  const diffBytes = bytes(input.diffBytes);
  if (diffBytes === undefined) return;
  return {
    taskId: input.taskId,
    principalId: input.principalId,
    operation: input.operation,
    request: input.request,
    repository: input.repository,
    baseline: input.baseline,
    discovery: input.discovery,
    transactionDigest: input.transactionDigest,
    diffBytes,
  };
}

function approvalOnly(input: unknown): ApprovalRequest | undefined {
  return isRecord(input) &&
    exactKeys(input, ["approval"]) &&
    isApprovalRequest(input.approval)
    ? input.approval
    : undefined;
}

function availability(
  record: ApprovalRecord | undefined,
  current: ApprovalRequest,
  expected: ApprovalState,
):
  | Exclude<ApprovalTransitionResult, { readonly status: "accepted" }>
  | undefined {
  if (record === undefined || record.current !== current)
    return { status: "rejected", code: "APPROVAL_STALE" };
  if (record.state === "cancelled")
    return { status: "rejected", code: "APPROVAL_CANCELLED" };
  if (record.state === "authenticating" || record.state === "revalidating")
    return { status: "rejected", code: "APPROVAL_BUSY" };
  if (record.state !== expected || current.state !== expected)
    return { status: "rejected", code: "APPROVAL_STALE" };
  return undefined;
}

function transition(
  current: ApprovalRequest,
  state: ApprovalState,
  challenge: ApprovalChallenge | null,
): ApprovalRequest {
  const next = createApproval({
    ...current,
    state,
    version: current.version + 1,
    challenge,
  });
  return next;
}

function createApproval(input: ApprovalRequest): ApprovalRequest {
  const result = Object.freeze({
    ...input,
    diffBytes: Object.freeze([...input.diffBytes]),
  });
  approvals.add(result);
  return result;
}

function matchesAuthentication(
  raw: unknown,
  challenge: ApprovalChallenge,
  verifiedAtMs: number,
): boolean {
  return (
    isRecord(raw) &&
    exactKeys(raw, [
      "challengeDigest",
      "taskId",
      "principalId",
      "operation",
      "authorized",
      "verifiedAtMs",
    ]) &&
    raw.challengeDigest === challenge.challengeDigest &&
    raw.taskId === challenge.taskId &&
    raw.principalId === challenge.principalId &&
    raw.operation === challenge.operation &&
    raw.authorized === true &&
    raw.verifiedAtMs === verifiedAtMs
  );
}

function readClock(clock: ClockPort): number | undefined {
  try {
    const value = clock.now();
    return Number.isSafeInteger(value) &&
      typeof value === "number" &&
      value >= 0
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function bytes(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_194_304)
    return;
  const result: number[] = [];
  for (const item of value) {
    if (
      !Number.isInteger(item) ||
      typeof item !== "number" ||
      item < 0 ||
      item > 255
    )
      return;
    result.push(item);
  }
  return Object.freeze(result);
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function currentState(record: ApprovalRecord): ApprovalRecord["state"] {
  return record.state;
}
