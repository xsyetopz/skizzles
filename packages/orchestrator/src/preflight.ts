import { bytesOf, exactKeys, isRecord, nonempty } from "./codec.ts";
import { type Digest, digestBytes, digestValue } from "./digest.ts";
import { isNormalizedRequest, type NormalizedRequest } from "./intent.ts";
import {
  captureRepository,
  isRepositoryContext,
  type RepositoryAuthorityPort,
  type RepositoryContext,
  type RepositoryResult,
} from "./repository.ts";

export type InvariantState = "satisfied" | "violated" | "approval-required";

export interface InvariantEvidence {
  readonly source: string;
  readonly bytes: readonly number[];
  readonly digest: Digest;
}

export interface VerifiedInvariant {
  readonly id: string;
  readonly state: InvariantState;
  readonly evidence: readonly InvariantEvidence[];
}

export interface PreflightApproval {
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly invariants: readonly VerifiedInvariant[];
  readonly graphDigest: Digest;
  readonly decisionDigest: Digest;
}

export interface RepositoryGraphPort {
  inspect: (input: {
    readonly repositoryId: string;
    readonly requestDigest: Digest;
    readonly treeDigest: Digest;
    readonly anchors: RepositoryContext["anchors"];
  }) => unknown | Promise<unknown>;
}

export type PreflightResult =
  | { readonly status: "accepted"; readonly approval: PreflightApproval }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_PREFLIGHT_INPUT"
        | "INVALID_REPOSITORY"
        | "REPOSITORY_AUTHORITY_REJECTED"
        | "GRAPH_AUTHORITY_REJECTED"
        | "INVARIANT_VIOLATION";
      readonly issues: readonly string[];
    }
  | {
      readonly status: "needs-approval";
      readonly code: "INVARIANT_APPROVAL_REQUIRED";
      readonly issues: readonly string[];
    };

const states = new Set<string>(["satisfied", "violated", "approval-required"]);
function isInvariantState(value: unknown): value is InvariantState {
  return typeof value === "string" && states.has(value);
}

export class PreflightEngine {
  private readonly repository: RepositoryAuthorityPort;
  private readonly graph: RepositoryGraphPort;
  private readonly required: ReadonlySet<string>;

  constructor(
    repository: RepositoryAuthorityPort,
    graph: RepositoryGraphPort,
    required: ReadonlySet<string>,
  ) {
    this.repository = repository;
    this.graph = graph;
    this.required = required;
  }

  async evaluate(input: unknown): Promise<PreflightResult> {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["request", "repository"]) &&
        isNormalizedRequest(input.request)
      )
    ) {
      return {
        status: "rejected",
        code: "INVALID_PREFLIGHT_INPUT",
        issues: Object.freeze(["invalid-input"]),
      };
    }
    const captured = await this.capture(input.request, input.repository);
    if (captured.status === "rejected") {
      return {
        status: "rejected",
        code: captured.code,
        issues: Object.freeze(["repository-authority"]),
      };
    }
    return this.evaluateCaptured(input.request, captured.context);
  }

  capture(
    request: NormalizedRequest,
    repository: unknown,
  ): Promise<RepositoryResult> {
    return captureRepository(this.repository, request, repository);
  }

  async evaluateCaptured(
    request: NormalizedRequest,
    repository: RepositoryContext,
  ): Promise<PreflightResult> {
    if (
      !isNormalizedRequest(request) ||
      !isRepositoryContext(repository) ||
      repository.requestDigest !== request.intentDigest
    ) {
      return {
        status: "rejected",
        code: "INVALID_PREFLIGHT_INPUT",
        issues: Object.freeze(["invalid-input"]),
      };
    }
    let rawGraph: unknown;
    try {
      rawGraph = await this.graph.inspect(
        Object.freeze({
          repositoryId: repository.repositoryId,
          requestDigest: repository.requestDigest,
          treeDigest: repository.treeDigest,
          anchors: repository.anchors,
        }),
      );
    } catch {
      return this.graphRejected("authority-failure");
    }
    const parsed = parseGraph(rawGraph, repository, this.required);
    if (parsed === undefined) {
      return this.graphRejected("invalid-graph-snapshot");
    }
    const issues = Object.freeze(
      parsed.invariants
        .filter((invariant) => invariant.state !== "satisfied")
        .map((invariant) => invariant.id),
    );
    if (parsed.invariants.some((invariant) => invariant.state === "violated")) {
      return { status: "rejected", code: "INVARIANT_VIOLATION", issues };
    }
    if (
      parsed.invariants.some(
        (invariant) => invariant.state === "approval-required",
      )
    ) {
      return {
        status: "needs-approval",
        code: "INVARIANT_APPROVAL_REQUIRED",
        issues,
      };
    }
    const decisionDigest = digestValue({
      requestDigest: request.intentDigest,
      contextDigest: repository.contextDigest,
      graphDigest: parsed.graphDigest,
      invariants: parsed.invariants.map(({ id, state, evidence }) => ({
        id,
        state,
        evidence: evidence.map(({ source, digest }) => ({ source, digest })),
      })),
    });
    const approval: PreflightApproval = Object.freeze({
      request,
      repository,
      invariants: parsed.invariants,
      graphDigest: parsed.graphDigest,
      decisionDigest,
    });
    return { status: "accepted", approval };
  }

  private graphRejected(issue: string): PreflightResult {
    return {
      status: "rejected",
      code: "GRAPH_AUTHORITY_REJECTED",
      issues: Object.freeze([issue]),
    };
  }
}

function parseGraph(
  value: unknown,
  context: RepositoryContext,
  required: ReadonlySet<string>,
):
  | {
      readonly invariants: readonly VerifiedInvariant[];
      readonly graphDigest: Digest;
    }
  | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, [
        "repositoryId",
        "requestDigest",
        "treeDigest",
        "snapshotBytes",
        "invariants",
      ])
    ) ||
    value.repositoryId !== context.repositoryId ||
    value.requestDigest !== context.requestDigest ||
    value.treeDigest !== context.treeDigest ||
    !Array.isArray(value.invariants)
  ) {
    return;
  }
  const snapshotBytes = bytesOf(value.snapshotBytes);
  if (snapshotBytes === undefined || snapshotBytes.length === 0) {
    return;
  }
  const seen = new Set<string>();
  const invariants: VerifiedInvariant[] = [];
  for (const item of value.invariants) {
    if (
      !(
        isRecord(item) &&
        exactKeys(item, ["id", "state", "evidence"]) &&
        nonempty(item.id)
      ) ||
      seen.has(item.id) ||
      !required.has(item.id) ||
      !isInvariantState(item.state) ||
      !Array.isArray(item.evidence) ||
      item.evidence.length === 0
    ) {
      return;
    }
    const evidence: InvariantEvidence[] = [];
    for (const reference of item.evidence) {
      if (
        !(
          isRecord(reference) &&
          exactKeys(reference, ["source", "bytes"]) &&
          nonempty(reference.source)
        )
      ) {
        return;
      }
      const bytes = bytesOf(reference.bytes);
      if (bytes === undefined || bytes.length === 0) {
        return;
      }
      evidence.push(
        Object.freeze({
          source: reference.source,
          bytes,
          digest: digestBytes(Uint8Array.from(bytes)),
        }),
      );
    }
    seen.add(item.id);
    invariants.push(
      Object.freeze({
        id: item.id,
        state: item.state,
        evidence: Object.freeze(evidence),
      }),
    );
  }
  if (
    seen.size !== required.size ||
    [...required].some((id) => !seen.has(id))
  ) {
    return;
  }
  invariants.sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    invariants: Object.freeze(invariants),
    graphDigest: digestValue({
      repositoryId: context.repositoryId,
      requestDigest: context.requestDigest,
      treeDigest: context.treeDigest,
      snapshotDigest: digestBytes(Uint8Array.from(snapshotBytes)),
      invariants: invariants.map(({ id, state, evidence }) => ({
        id,
        state,
        evidence: evidence.map(({ source, digest }) => ({ source, digest })),
      })),
    }),
  });
}
