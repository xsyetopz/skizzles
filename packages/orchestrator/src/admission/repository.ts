import { bytesOf, exactKeys, isRecord, nonempty } from "../codec.ts";
import { type Digest, digestBytes, digestValue } from "../digest.ts";
import { isNormalizedRequest, type NormalizedRequest } from "./intent.ts";

export const ANCHOR_PRECEDENCE = Object.freeze([
  "language-runtime",
  "public-contract",
  "build-tool",
  "repository",
  "user-preference",
] as const);

export type AnchorPrecedence = (typeof ANCHOR_PRECEDENCE)[number];

export interface RepositoryAnchor {
  readonly id: string;
  readonly repositoryId: string;
  readonly requestDigest: Digest;
  readonly treeDigest: Digest;
  readonly contentBytes: readonly number[];
  readonly contentDigest: Digest;
  readonly precedence: AnchorPrecedence;
}

export interface RepositoryContext {
  readonly repositoryId: string;
  readonly requestDigest: Digest;
  readonly treeBytes: readonly number[];
  readonly treeDigest: Digest;
  readonly anchors: readonly RepositoryAnchor[];
  readonly contextDigest: Digest;
}

export interface RepositoryAuthorityPort {
  capture: (input: {
    readonly repositoryId: string;
    readonly requestDigest: Digest;
    readonly rawDigest: Digest;
  }) => unknown | Promise<unknown>;
}

export type EffectKind = "none" | "structural";

export interface EffectClassification {
  readonly effect: EffectKind;
  readonly requestDigest: Digest;
  readonly rawDigest: Digest;
  readonly repositoryId: string;
  readonly treeDigest: Digest;
  readonly contextDigest: Digest;
  readonly policyId: string;
  readonly evidenceId: string;
  readonly classificationDigest: Digest;
}

export interface EffectClassificationAuthorityPort {
  classify: (input: {
    readonly request: NormalizedRequest;
    readonly repository: RepositoryContext;
  }) => unknown | Promise<unknown>;
}

export type EffectClassificationResult =
  | {
      readonly status: "accepted";
      readonly classification: EffectClassification;
    }
  | {
      readonly status: "rejected";
      readonly code: "EFFECT_CLASSIFICATION_REJECTED";
    };

export type RepositoryResult =
  | { readonly status: "accepted"; readonly context: RepositoryContext }
  | {
      readonly status: "rejected";
      readonly code: "INVALID_REPOSITORY" | "REPOSITORY_AUTHORITY_REJECTED";
    };

function isPrecedence(value: unknown): value is AnchorPrecedence {
  return (
    value === "language-runtime" ||
    value === "public-contract" ||
    value === "build-tool" ||
    value === "repository" ||
    value === "user-preference"
  );
}

const repositoryContexts = new WeakSet<object>();

export function isRepositoryContext(
  value: unknown,
): value is RepositoryContext {
  return isRecord(value) && repositoryContexts.has(value);
}

export async function classifyEffect(
  authority: EffectClassificationAuthorityPort,
  request: NormalizedRequest,
  repository: RepositoryContext,
): Promise<EffectClassificationResult> {
  if (!isNormalizedRequest(request) || !isRepositoryContext(repository)) {
    return { status: "rejected", code: "EFFECT_CLASSIFICATION_REJECTED" };
  }
  try {
    const raw = await authority.classify(
      Object.freeze({ request, repository }),
    );
    if (
      !isRecord(raw) ||
      !exactKeys(raw, [
        "effect",
        "requestDigest",
        "rawDigest",
        "repositoryId",
        "treeDigest",
        "contextDigest",
        "policyId",
        "evidenceId",
      ])
    ) {
      return { status: "rejected", code: "EFFECT_CLASSIFICATION_REJECTED" };
    }
    const effect = raw.effect;
    const requestDigest = raw.requestDigest;
    const rawDigest = raw.rawDigest;
    const repositoryId = raw.repositoryId;
    const treeDigest = raw.treeDigest;
    const contextDigest = raw.contextDigest;
    const policyId = raw.policyId;
    const evidenceId = raw.evidenceId;
    if (
      (effect !== "none" && effect !== "structural") ||
      requestDigest !== request.intentDigest ||
      rawDigest !== request.rawDigest ||
      repositoryId !== repository.repositoryId ||
      treeDigest !== repository.treeDigest ||
      contextDigest !== repository.contextDigest ||
      !nonempty(policyId, 128) ||
      !nonempty(evidenceId, 256)
    ) {
      return { status: "rejected", code: "EFFECT_CLASSIFICATION_REJECTED" };
    }
    const effectKind: EffectKind = effect;
    const material = {
      effect: effectKind,
      requestDigest,
      rawDigest,
      repositoryId,
      treeDigest,
      contextDigest,
      policyId,
      evidenceId,
    };
    return {
      status: "accepted",
      classification: Object.freeze({
        ...material,
        classificationDigest: digestValue(material),
      }),
    };
  } catch {
    return { status: "rejected", code: "EFFECT_CLASSIFICATION_REJECTED" };
  }
}

export async function captureRepository(
  authority: RepositoryAuthorityPort,
  request: NormalizedRequest,
  input: unknown,
): Promise<RepositoryResult> {
  if (!(isRecord(input) && exactKeys(input, ["id"]) && nonempty(input.id))) {
    return { status: "rejected", code: "INVALID_REPOSITORY" };
  }
  let result: unknown;
  try {
    result = await authority.capture(
      Object.freeze({
        repositoryId: input.id,
        requestDigest: request.intentDigest,
        rawDigest: request.rawDigest,
      }),
    );
  } catch {
    return { status: "rejected", code: "REPOSITORY_AUTHORITY_REJECTED" };
  }
  if (
    !(
      isRecord(result) &&
      exactKeys(result, [
        "repositoryId",
        "requestDigest",
        "treeBytes",
        "anchors",
      ])
    ) ||
    result.repositoryId !== input.id ||
    result.requestDigest !== request.intentDigest ||
    !Array.isArray(result.anchors) ||
    result.anchors.length === 0
  ) {
    return { status: "rejected", code: "REPOSITORY_AUTHORITY_REJECTED" };
  }
  const treeBytes = bytesOf(result.treeBytes);
  if (treeBytes === undefined || treeBytes.length === 0) {
    return { status: "rejected", code: "REPOSITORY_AUTHORITY_REJECTED" };
  }
  const treeDigest = digestBytes(Uint8Array.from(treeBytes));
  const ids = new Set<string>();
  const anchors: RepositoryAnchor[] = [];
  for (const item of result.anchors) {
    if (
      !(
        isRecord(item) &&
        exactKeys(item, ["id", "precedence", "contentBytes"]) &&
        nonempty(item.id)
      ) ||
      ids.has(item.id) ||
      !isPrecedence(item.precedence)
    ) {
      return { status: "rejected", code: "REPOSITORY_AUTHORITY_REJECTED" };
    }
    const contentBytes = bytesOf(item.contentBytes);
    if (contentBytes === undefined || contentBytes.length === 0) {
      return { status: "rejected", code: "REPOSITORY_AUTHORITY_REJECTED" };
    }
    ids.add(item.id);
    anchors.push(
      Object.freeze({
        id: item.id,
        repositoryId: input.id,
        requestDigest: request.intentDigest,
        treeDigest,
        contentBytes,
        contentDigest: digestBytes(Uint8Array.from(contentBytes)),
        precedence: item.precedence,
      }),
    );
  }
  anchors.sort(
    (left, right) =>
      ANCHOR_PRECEDENCE.indexOf(left.precedence) -
        ANCHOR_PRECEDENCE.indexOf(right.precedence) ||
      left.id.localeCompare(right.id),
  );
  const contextDigest = digestValue({
    repositoryId: input.id,
    requestDigest: request.intentDigest,
    treeDigest,
    anchors: anchors.map(({ id, contentDigest, precedence }) => ({
      id,
      contentDigest,
      precedence,
    })),
  });
  const context: RepositoryContext = Object.freeze({
    repositoryId: input.id,
    requestDigest: request.intentDigest,
    treeBytes,
    treeDigest,
    anchors: Object.freeze(anchors),
    contextDigest,
  });
  repositoryContexts.add(context);
  return { status: "accepted", context };
}
