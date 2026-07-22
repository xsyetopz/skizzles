import { exactKeys, isRecord, nonempty, stringArray } from "../codec.ts";
import { type Digest, digestValue } from "../digest.ts";
import { isNormalizedRequest, type NormalizedRequest } from "../intent.ts";
import { isRepositoryContext, type RepositoryContext } from "../repository.ts";
import type { ClockPort } from "./execution.ts";

export interface DiscoveryBounds {
  readonly maxDepth: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxMs: number;
}

export interface DiscoveryPolicy {
  readonly includedRoots: readonly string[];
  readonly exclusions: readonly string[];
  readonly bounds: DiscoveryBounds;
  readonly maxExpansions: number;
}

export interface DiscoveryAuthorityPort {
  scan(input: {
    readonly repositoryId: string;
    readonly requestDigest: Digest;
    readonly treeDigest: Digest;
    readonly root: string;
    readonly exclusions: readonly string[];
    readonly bounds: DiscoveryBounds;
    readonly taskId?: string;
    readonly taskEpochDigest?: Digest;
  }): unknown | Promise<unknown>;
  reviewExpansion(input: {
    readonly discoveryDigest: Digest;
    readonly repositoryId: string;
    readonly requestDigest: Digest;
    readonly treeDigest: Digest;
    readonly currentRoot: string;
    readonly proposedRoot: string;
    readonly expansion: number;
  }): unknown | Promise<unknown>;
}

export interface DiscoveryEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes: number;
}

export type DiscoveryStopReason =
  | "depth"
  | "files"
  | "bytes"
  | "time"
  | "authority";

export interface DiscoverySnapshot {
  readonly repositoryId: string;
  readonly requestDigest: Digest;
  readonly treeDigest: Digest;
  readonly root: string;
  readonly entries: readonly DiscoveryEntry[];
  readonly skippedSymlinks: readonly string[];
  readonly complete: boolean;
  readonly stoppedBy: DiscoveryStopReason | null;
  readonly fileCount: number;
  readonly byteCount: number;
  readonly maxDepth: number;
  readonly elapsedMs: number;
  readonly expansion: number;
  readonly reviewId: string | null;
  readonly taskId: string | null;
  readonly taskEpochDigest: Digest | null;
  readonly discoveryDigest: Digest;
}

export type DiscoveryResult =
  | { readonly status: "accepted"; readonly discovery: DiscoverySnapshot }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_DISCOVERY_INPUT"
        | "DISCOVERY_OUT_OF_SCOPE"
        | "DISCOVERY_AUTHORITY_REJECTED"
        | "DISCOVERY_LIMIT_EXCEEDED"
        | "DISCOVERY_EXPANSION_REJECTED"
        | "CLOCK_REJECTED";
    };

const snapshots = new WeakSet<object>();

export function isDiscoverySnapshot(
  value: unknown,
): value is DiscoverySnapshot {
  return isRecord(value) && snapshots.has(value);
}

export class DiscoveryController {
  private readonly authority: DiscoveryAuthorityPort;
  private readonly clock: ClockPort;
  private readonly policy: DiscoveryPolicy;

  constructor(
    authority: DiscoveryAuthorityPort,
    clock: ClockPort,
    policy: DiscoveryPolicy,
  ) {
    this.authority = authority;
    this.clock = clock;
    this.policy = policy;
  }

  async discover(input: unknown): Promise<DiscoveryResult> {
    const parsed = parseInput(input);
    if (parsed === undefined)
      return { status: "rejected", code: "INVALID_DISCOVERY_INPUT" };
    const root = normalizePath(parsed.root);
    if (root === undefined || !this.inScope(root))
      return { status: "rejected", code: "DISCOVERY_OUT_OF_SCOPE" };
    return this.scan(parsed.request, parsed.repository, root, 0, null, null);
  }

  async discoverTask(input: unknown): Promise<DiscoveryResult> {
    const parsed = parseTaskInput(input);
    if (parsed === undefined) {
      return { status: "rejected", code: "INVALID_DISCOVERY_INPUT" };
    }
    const root = normalizePath(parsed.root);
    if (root === undefined || !this.inScope(root)) {
      return { status: "rejected", code: "DISCOVERY_OUT_OF_SCOPE" };
    }
    return this.scan(
      parsed.request,
      parsed.repository,
      root,
      0,
      null,
      Object.freeze({
        taskId: parsed.taskId,
        taskEpochDigest: parsed.taskEpochDigest,
      }),
    );
  }

  async expand(input: unknown): Promise<DiscoveryResult> {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["discovery", "root"]) &&
        isDiscoverySnapshot(input.discovery)
      ) ||
      typeof input.root !== "string"
    )
      return { status: "rejected", code: "INVALID_DISCOVERY_INPUT" };
    const root = normalizePath(input.root);
    if (root === undefined || !this.inScope(root))
      return { status: "rejected", code: "DISCOVERY_OUT_OF_SCOPE" };
    const expansion = input.discovery.expansion + 1;
    if (expansion > this.policy.maxExpansions)
      return { status: "rejected", code: "DISCOVERY_EXPANSION_REJECTED" };
    let raw: unknown;
    try {
      raw = await this.authority.reviewExpansion(
        Object.freeze({
          discoveryDigest: input.discovery.discoveryDigest,
          repositoryId: input.discovery.repositoryId,
          requestDigest: input.discovery.requestDigest,
          treeDigest: input.discovery.treeDigest,
          currentRoot: input.discovery.root,
          proposedRoot: root,
          expansion,
        }),
      );
    } catch {
      return { status: "rejected", code: "DISCOVERY_EXPANSION_REJECTED" };
    }
    if (
      !(
        isRecord(raw) &&
        exactKeys(raw, [
          "discoveryDigest",
          "proposedRoot",
          "expansion",
          "approved",
          "reviewId",
        ])
      ) ||
      raw.discoveryDigest !== input.discovery.discoveryDigest ||
      raw.proposedRoot !== root ||
      raw.expansion !== expansion ||
      raw.approved !== true ||
      !nonempty(raw.reviewId, 256)
    )
      return { status: "rejected", code: "DISCOVERY_EXPANSION_REJECTED" };
    const request = snapshotRequest(input.discovery);
    const repository = snapshotRepository(input.discovery);
    const taskScope =
      input.discovery.taskId === null ||
      input.discovery.taskEpochDigest === null
        ? null
        : Object.freeze({
            taskId: input.discovery.taskId,
            taskEpochDigest: input.discovery.taskEpochDigest,
          });
    return this.scan(
      request,
      repository,
      root,
      expansion,
      raw.reviewId,
      taskScope,
    );
  }

  private async scan(
    request: Pick<NormalizedRequest, "intentDigest">,
    repository: Pick<
      RepositoryContext,
      "repositoryId" | "requestDigest" | "treeDigest"
    >,
    root: string,
    expansion: number,
    reviewId: string | null,
    taskScope: Readonly<{
      taskId: string;
      taskEpochDigest: Digest;
    }> | null,
  ): Promise<DiscoveryResult> {
    const started = readClock(this.clock);
    if (started === undefined)
      return { status: "rejected", code: "CLOCK_REJECTED" };
    let raw: unknown;
    try {
      raw = await this.authority.scan(
        Object.freeze({
          repositoryId: repository.repositoryId,
          requestDigest: request.intentDigest,
          treeDigest: repository.treeDigest,
          root,
          exclusions: this.policy.exclusions,
          bounds: this.policy.bounds,
          ...(taskScope === null ? {} : taskScope),
        }),
      );
    } catch {
      return { status: "rejected", code: "DISCOVERY_AUTHORITY_REJECTED" };
    }
    const ended = readClock(this.clock);
    if (ended === undefined || ended < started)
      return { status: "rejected", code: "CLOCK_REJECTED" };
    const elapsedMs = ended - started;
    if (elapsedMs > this.policy.bounds.maxMs)
      return { status: "rejected", code: "DISCOVERY_LIMIT_EXCEEDED" };
    const snapshot = parseScan(
      raw,
      request.intentDigest,
      repository,
      root,
      elapsedMs,
      expansion,
      reviewId,
      taskScope,
      this.policy,
    );
    if (snapshot === undefined)
      return { status: "rejected", code: "DISCOVERY_AUTHORITY_REJECTED" };
    return { status: "accepted", discovery: snapshot };
  }

  private inScope(path: string): boolean {
    return (
      this.policy.includedRoots.some((root) => contains(root, path)) &&
      !this.policy.exclusions.some((excluded) => contains(excluded, path))
    );
  }
}

function parseTaskInput(input: unknown):
  | {
      readonly request: NormalizedRequest;
      readonly repository: RepositoryContext;
      readonly root: string;
      readonly taskId: string;
      readonly taskEpochDigest: Digest;
    }
  | undefined {
  if (
    !(
      isRecord(input) &&
      exactKeys(input, [
        "request",
        "repository",
        "root",
        "taskId",
        "taskEpochDigest",
      ]) &&
      isNormalizedRequest(input.request) &&
      isRepositoryContext(input.repository) &&
      input.request.intentDigest === input.repository.requestDigest &&
      typeof input.root === "string" &&
      nonempty(input.taskId, 128) &&
      isDigest(input["taskEpochDigest"])
    )
  ) {
    return;
  }
  return {
    request: input.request,
    repository: input.repository,
    root: input.root,
    taskId: input.taskId,
    taskEpochDigest: input["taskEpochDigest"],
  };
}

export function parseDiscoveryPolicy(
  value: unknown,
): DiscoveryPolicy | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, [
        "includedRoots",
        "exclusions",
        "bounds",
        "maxExpansions",
      ])
    )
  )
    return;
  const included = normalizePaths(value.includedRoots);
  const excluded = normalizePaths(value.exclusions);
  const bounds = parseBounds(value.bounds);
  if (
    included === undefined ||
    included.length === 0 ||
    excluded === undefined ||
    bounds === undefined ||
    !Number.isSafeInteger(value.maxExpansions) ||
    typeof value.maxExpansions !== "number" ||
    value.maxExpansions < 0 ||
    value.maxExpansions > 16 ||
    included.some((root) => excluded.some((path) => root === path))
  )
    return;
  return Object.freeze({
    includedRoots: included,
    exclusions: excluded,
    bounds,
    maxExpansions: value.maxExpansions,
  });
}

function parseInput(input: unknown):
  | {
      readonly request: NormalizedRequest;
      readonly repository: RepositoryContext;
      readonly root: string;
    }
  | undefined {
  if (
    !(
      isRecord(input) &&
      exactKeys(input, ["request", "repository", "root"]) &&
      isNormalizedRequest(input.request) &&
      isRepositoryContext(input.repository)
    ) ||
    input.request.intentDigest !== input.repository.requestDigest ||
    typeof input.root !== "string"
  )
    return;
  return {
    request: input.request,
    repository: input.repository,
    root: input.root,
  };
}

function parseBounds(value: unknown): DiscoveryBounds | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, ["maxDepth", "maxFiles", "maxBytes", "maxMs"])
    )
  )
    return;
  const values = [value.maxDepth, value.maxFiles, value.maxBytes, value.maxMs];
  if (
    values.some(
      (item) =>
        !Number.isSafeInteger(item) || typeof item !== "number" || item <= 0,
    )
  )
    return;
  if (
    !(
      positiveInteger(value.maxDepth) &&
      positiveInteger(value.maxFiles) &&
      positiveInteger(value.maxBytes) &&
      positiveInteger(value.maxMs)
    )
  )
    return;
  return Object.freeze({
    maxDepth: value.maxDepth,
    maxFiles: value.maxFiles,
    maxBytes: value.maxBytes,
    maxMs: value.maxMs,
  });
}

function parseScan(
  raw: unknown,
  requestDigest: Digest,
  repository: Pick<
    RepositoryContext,
    "repositoryId" | "requestDigest" | "treeDigest"
  >,
  root: string,
  elapsedMs: number,
  expansion: number,
  reviewId: string | null,
  taskScope: Readonly<{
    taskId: string;
    taskEpochDigest: Digest;
  }> | null,
  policy: DiscoveryPolicy,
): DiscoverySnapshot | undefined {
  if (
    !(
      isRecord(raw) &&
      exactKeys(
        raw,
        [
          "repositoryId",
          "requestDigest",
          "treeDigest",
          "root",
          "entries",
          "skippedSymlinks",
          "complete",
          "stoppedBy",
        ],
        ["taskId", "taskEpochDigest"],
      )
    ) ||
    raw.repositoryId !== repository.repositoryId ||
    raw.requestDigest !== requestDigest ||
    raw.treeDigest !== repository.treeDigest ||
    raw.root !== root ||
    typeof raw.complete !== "boolean" ||
    !isStopReason(raw.stoppedBy, raw.complete) ||
    !matchesTaskScope(raw, taskScope)
  )
    return;
  const symlinks = normalizePaths(raw.skippedSymlinks);
  if (symlinks === undefined || symlinks.some((path) => !contains(root, path)))
    return;
  if (!Array.isArray(raw.entries)) return;
  const entries: DiscoveryEntry[] = [];
  const paths = new Set<string>();
  for (const value of raw.entries) {
    if (
      !(isRecord(value) && exactKeys(value, ["path", "kind", "bytes"])) ||
      typeof value.path !== "string" ||
      (value.kind !== "file" && value.kind !== "directory") ||
      !Number.isSafeInteger(value.bytes) ||
      typeof value.bytes !== "number" ||
      value.bytes < 0
    )
      return;
    const path = normalizePath(value.path);
    if (
      path === undefined ||
      !contains(root, path) ||
      paths.has(path) ||
      policy.exclusions.some((excluded) => contains(excluded, path)) ||
      symlinks.some((link) => contains(link, path))
    )
      return;
    paths.add(path);
    entries.push(Object.freeze({ path, kind: value.kind, bytes: value.bytes }));
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const files = entries.filter((entry) => entry.kind === "file");
  const fileCount = files.length;
  const byteCount = files.reduce((sum, entry) => sum + entry.bytes, 0);
  const maxDepth = entries.reduce(
    (maximum, entry) => Math.max(maximum, relativeDepth(root, entry.path)),
    0,
  );
  if (
    fileCount > policy.bounds.maxFiles ||
    byteCount > policy.bounds.maxBytes ||
    maxDepth > policy.bounds.maxDepth
  )
    return;
  const material = {
    repositoryId: repository.repositoryId,
    requestDigest,
    treeDigest: repository.treeDigest,
    root,
    entries,
    skippedSymlinks: symlinks,
    complete: raw.complete,
    stoppedBy: raw.stoppedBy,
    fileCount,
    byteCount,
    maxDepth,
    elapsedMs,
    expansion,
    reviewId,
    taskId: taskScope?.taskId ?? null,
    taskEpochDigest: taskScope?.taskEpochDigest ?? null,
  };
  const snapshot = Object.freeze({
    ...material,
    discoveryDigest: digestValue(material),
  });
  snapshots.add(snapshot);
  return snapshot;
}

function matchesTaskScope(
  raw: Readonly<Record<string, unknown>>,
  scope: Readonly<{ taskId: string; taskEpochDigest: Digest }> | null,
): boolean {
  if (scope === null) {
    return (
      !Object.hasOwn(raw, "taskId") && !Object.hasOwn(raw, "taskEpochDigest")
    );
  }
  return (
    raw["taskId"] === scope.taskId &&
    raw["taskEpochDigest"] === scope.taskEpochDigest
  );
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function normalizePaths(value: unknown): readonly string[] | undefined {
  const values = stringArray(value);
  if (values === undefined || values.length > 256) return;
  const normalized = values.map(normalizePath);
  if (normalized.some((path) => path === undefined)) return;
  const result = normalized.filter(
    (path): path is string => path !== undefined,
  );
  if (new Set(result).size !== result.length) return;
  return Object.freeze([...result].sort());
}

function normalizePath(value: string): string | undefined {
  if (
    !nonempty(value, 1024) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\u0000")
  )
    return;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".."))
    return;
  return parts.join("/");
}

function contains(root: string, path: string): boolean {
  return root === path || path.startsWith(`${root}/`);
}

function relativeDepth(root: string, path: string): number {
  if (path === root) return 0;
  return path.slice(root.length + 1).split("/").length;
}

function isStopReason(
  value: unknown,
  complete: boolean,
): value is DiscoveryStopReason | null {
  if (complete) return value === null;
  return (
    value === "depth" ||
    value === "files" ||
    value === "bytes" ||
    value === "time" ||
    value === "authority"
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

function snapshotRequest(
  snapshot: DiscoverySnapshot,
): Pick<NormalizedRequest, "intentDigest"> {
  return { intentDigest: snapshot.requestDigest };
}

function snapshotRepository(
  snapshot: DiscoverySnapshot,
): Pick<RepositoryContext, "repositoryId" | "requestDigest" | "treeDigest"> {
  return {
    repositoryId: snapshot.repositoryId,
    requestDigest: snapshot.requestDigest,
    treeDigest: snapshot.treeDigest,
  };
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}
