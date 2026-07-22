import {
  isNormalizedRequest,
  type NormalizedRequest,
} from "../admission/intent.ts";
import {
  isRepositoryContext,
  type RepositoryContext,
} from "../admission/repository.ts";
import { exactKeys, isRecord, nonempty, stringArray } from "../codec.ts";
import { type Digest, digestBytes, digestValue } from "../digest.ts";

export type TargetState =
  | "clean"
  | "staged"
  | "unstaged"
  | "untracked"
  | "deleted"
  | "renamed"
  | "conflicted";

export interface TargetStatus {
  readonly path: string;
  readonly state: TargetState;
  readonly renamedFrom?: string;
}

export interface TargetBaseline {
  readonly reservationId: Digest;
  readonly repositoryId: string;
  readonly requestDigest: Digest;
  readonly treeDigest: Digest;
  readonly targets: readonly string[];
  readonly headDigest: Digest;
  readonly indexDigest: Digest;
  readonly worktreeDigest: Digest;
  readonly statusDigest: Digest;
  readonly statuses: readonly TargetStatus[];
  readonly baselineDigest: Digest;
}

export interface TargetAuthorityPort {
  capture(input: {
    readonly reservationId: Digest;
    readonly repositoryId: string;
    readonly requestDigest: Digest;
    readonly treeDigest: Digest;
    readonly targets: readonly string[];
  }): unknown | Promise<unknown>;
  revalidate(input: TargetBaseline): unknown | Promise<unknown>;
}

export type TargetBaselineResult =
  | { readonly status: "accepted"; readonly baseline: TargetBaseline }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_TARGET_INPUT"
        | "TARGET_RESERVED"
        | "TARGET_AUTHORITY_REJECTED"
        | "TARGET_DIRTY";
    };

export type TargetRevalidation =
  | { readonly status: "unchanged" }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_TARGET_BASELINE"
        | "TARGET_BASELINE_RELEASED"
        | "TARGET_DRIFTED"
        | "TARGET_AUTHORITY_REJECTED";
    };

export type TargetReleaseResult =
  | { readonly status: "released" }
  | {
      readonly status: "rejected";
      readonly code: "INVALID_TARGET_BASELINE" | "TARGET_BASELINE_RELEASED";
    };

const baselines = new WeakSet<object>();

export function isTargetBaseline(value: unknown): value is TargetBaseline {
  return isRecord(value) && baselines.has(value);
}

export class TargetBaselineManager {
  private sequence = 0;
  private readonly reservations = new Map<string, string>();
  private readonly active = new Map<string, TargetBaseline>();
  private readonly authority: TargetAuthorityPort;

  constructor(authority: TargetAuthorityPort) {
    this.authority = authority;
  }

  async capture(input: unknown): Promise<TargetBaselineResult> {
    const parsed = parseCaptureInput(input);
    if (parsed === undefined) {
      return { status: "rejected", code: "INVALID_TARGET_INPUT" };
    }
    const key = reservationKey(parsed.repository.repositoryId, parsed.targets);
    if (this.overlaps(parsed.repository.repositoryId, parsed.targets)) {
      return { status: "rejected", code: "TARGET_RESERVED" };
    }
    this.sequence += 1;
    const reservationId = digestValue({ key, sequence: this.sequence });
    this.reservations.set(key, reservationId);
    let raw: unknown;
    try {
      raw = await this.authority.capture(
        Object.freeze({
          reservationId,
          repositoryId: parsed.repository.repositoryId,
          requestDigest: parsed.request.intentDigest,
          treeDigest: parsed.repository.treeDigest,
          targets: parsed.targets,
        }),
      );
      const baseline = parseAuthorityCapture(
        raw,
        reservationId,
        parsed.request,
        parsed.repository,
        parsed.targets,
      );
      if (baseline === undefined) {
        this.reservations.delete(key);
        return { status: "rejected", code: "TARGET_AUTHORITY_REJECTED" };
      }
      if (baseline.statuses.some((entry) => entry.state !== "clean")) {
        this.reservations.delete(key);
        return { status: "rejected", code: "TARGET_DIRTY" };
      }
      this.active.set(reservationId, baseline);
      return { status: "accepted", baseline };
    } catch {
      this.reservations.delete(key);
      return { status: "rejected", code: "TARGET_AUTHORITY_REJECTED" };
    }
  }

  async revalidate(input: unknown): Promise<TargetRevalidation> {
    if (!isTargetBaseline(input)) {
      return { status: "rejected", code: "INVALID_TARGET_BASELINE" };
    }
    if (this.active.get(input.reservationId) !== input) {
      return { status: "rejected", code: "TARGET_BASELINE_RELEASED" };
    }
    try {
      const raw = await this.authority.revalidate(input);
      if (!matchesRevalidation(raw, input)) {
        return { status: "rejected", code: "TARGET_DRIFTED" };
      }
      return { status: "unchanged" };
    } catch {
      return { status: "rejected", code: "TARGET_AUTHORITY_REJECTED" };
    }
  }

  release(input: unknown): TargetReleaseResult {
    if (!isTargetBaseline(input)) {
      return { status: "rejected", code: "INVALID_TARGET_BASELINE" };
    }
    if (this.active.get(input.reservationId) !== input) {
      return { status: "rejected", code: "TARGET_BASELINE_RELEASED" };
    }
    this.active.delete(input.reservationId);
    this.reservations.delete(reservationKey(input.repositoryId, input.targets));
    return { status: "released" };
  }

  private overlaps(repositoryId: string, targets: readonly string[]): boolean {
    for (const baseline of this.active.values()) {
      if (
        baseline.repositoryId === repositoryId &&
        targetSetsOverlap(baseline.targets, targets)
      ) {
        return true;
      }
    }
    for (const key of this.reservations.keys()) {
      const [reservedRepository, encodedTargets] = key.split("\u0000", 2);
      if (reservedRepository !== repositoryId || encodedTargets === undefined)
        continue;
      const reservedTargets = encodedTargets.split("\u0001");
      if (targetSetsOverlap(reservedTargets, targets)) return true;
    }
    return false;
  }
}

function parseCaptureInput(input: unknown):
  | {
      readonly request: NormalizedRequest;
      readonly repository: RepositoryContext;
      readonly targets: readonly string[];
    }
  | undefined {
  if (
    !(
      isRecord(input) &&
      exactKeys(input, ["request", "repository", "targets"]) &&
      isNormalizedRequest(input.request) &&
      isRepositoryContext(input.repository)
    ) ||
    input.request.intentDigest !== input.repository.requestDigest
  ) {
    return;
  }
  const rawTargets = stringArray(input.targets);
  if (
    rawTargets === undefined ||
    rawTargets.length === 0 ||
    rawTargets.length > 256
  )
    return;
  const normalized = rawTargets.map(normalizeTarget);
  if (normalized.some((target) => target === undefined)) return;
  const targets = normalized.filter(
    (target): target is string => target !== undefined,
  );
  const unique = Object.freeze([...new Set(targets)].sort());
  if (unique.length !== rawTargets.length) return;
  return {
    request: input.request,
    repository: input.repository,
    targets: unique,
  };
}

function normalizeTarget(value: string): string | undefined {
  if (
    !nonempty(value, 1024) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\u0000")
  ) {
    return;
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".."))
    return;
  return parts.join("/");
}

function parseAuthorityCapture(
  raw: unknown,
  reservationId: Digest,
  request: NormalizedRequest,
  repository: RepositoryContext,
  targets: readonly string[],
): TargetBaseline | undefined {
  if (
    !(
      isRecord(raw) &&
      exactKeys(raw, [
        "reservationId",
        "repositoryId",
        "requestDigest",
        "treeDigest",
        "targets",
        "headBytes",
        "indexBytes",
        "worktreeBytes",
        "statusBytes",
        "statuses",
      ])
    ) ||
    raw.reservationId !== reservationId ||
    raw.repositoryId !== repository.repositoryId ||
    raw.requestDigest !== request.intentDigest ||
    raw.treeDigest !== repository.treeDigest ||
    !sameStrings(raw.targets, targets)
  ) {
    return;
  }
  const head = byteArray(raw.headBytes);
  const index = byteArray(raw.indexBytes);
  const worktree = byteArray(raw.worktreeBytes);
  const status = byteArray(raw.statusBytes);
  if (
    head === undefined ||
    index === undefined ||
    worktree === undefined ||
    status === undefined
  )
    return;
  const statuses = parseStatuses(raw.statuses, targets);
  if (statuses === undefined) return;
  const material = {
    reservationId,
    repositoryId: repository.repositoryId,
    requestDigest: request.intentDigest,
    treeDigest: repository.treeDigest,
    targets,
    headDigest: digestBytes(Uint8Array.from(head)),
    indexDigest: digestBytes(Uint8Array.from(index)),
    worktreeDigest: digestBytes(Uint8Array.from(worktree)),
    statusDigest: digestBytes(Uint8Array.from(status)),
    statuses,
  };
  const baseline = Object.freeze({
    ...material,
    baselineDigest: digestValue(material),
  });
  baselines.add(baseline);
  return baseline;
}

function parseStatuses(
  raw: unknown,
  targets: readonly string[],
): readonly TargetStatus[] | undefined {
  if (!Array.isArray(raw) || raw.length !== targets.length) return;
  const result: TargetStatus[] = [];
  for (const value of raw) {
    if (!isRecord(value)) return;
    const renamed = value.state === "renamed";
    if (!exactKeys(value, ["path", "state"], renamed ? ["renamedFrom"] : []))
      return;
    if (
      typeof value.path !== "string" ||
      !targets.includes(value.path) ||
      !isTargetState(value.state) ||
      (renamed &&
        (typeof value.renamedFrom !== "string" ||
          normalizeTarget(value.renamedFrom) === undefined))
    )
      return;
    result.push(
      Object.freeze({
        path: value.path,
        state: value.state,
        ...(renamed && typeof value.renamedFrom === "string"
          ? { renamedFrom: value.renamedFrom }
          : {}),
      }),
    );
  }
  result.sort((left, right) => left.path.localeCompare(right.path));
  if (
    !sameStrings(
      result.map((entry) => entry.path),
      targets,
    )
  )
    return;
  return Object.freeze(result);
}

function matchesRevalidation(raw: unknown, baseline: TargetBaseline): boolean {
  return (
    isRecord(raw) &&
    exactKeys(raw, [
      "reservationId",
      "repositoryId",
      "requestDigest",
      "treeDigest",
      "targets",
      "headDigest",
      "indexDigest",
      "worktreeDigest",
      "statusDigest",
      "unchanged",
    ]) &&
    raw.reservationId === baseline.reservationId &&
    raw.repositoryId === baseline.repositoryId &&
    raw.requestDigest === baseline.requestDigest &&
    raw.treeDigest === baseline.treeDigest &&
    sameStrings(raw.targets, baseline.targets) &&
    raw.headDigest === baseline.headDigest &&
    raw.indexDigest === baseline.indexDigest &&
    raw.worktreeDigest === baseline.worktreeDigest &&
    raw.statusDigest === baseline.statusDigest &&
    raw.unchanged === true
  );
}

function byteArray(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_048_576)
    return;
  const bytes: number[] = [];
  for (const item of value) {
    if (!Number.isInteger(item) || item < 0 || item > 255) return;
    bytes.push(item);
  }
  return Object.freeze(bytes);
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  const parsed = stringArray(value);
  return (
    parsed !== undefined &&
    parsed.length === expected.length &&
    parsed.every((item, index) => item === expected[index])
  );
}

function isTargetState(value: unknown): value is TargetState {
  return (
    value === "clean" ||
    value === "staged" ||
    value === "unstaged" ||
    value === "untracked" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "conflicted"
  );
}

function reservationKey(
  repositoryId: string,
  targets: readonly string[],
): string {
  return `${repositoryId}\u0000${targets.join("\u0001")}`;
}

function targetSetsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((a) =>
    right.some(
      (b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`),
    ),
  );
}
