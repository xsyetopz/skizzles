import { digestValue } from "../../digest.ts";
import type {
  ContextFragment,
  ContextPlacement,
  PrioritizationReceipt,
} from "./contract.ts";

export interface PrioritizedContext {
  readonly fragments: readonly ContextFragment[];
  readonly receipt: PrioritizationReceipt;
}

interface RankedFragment {
  readonly fragment: ContextFragment;
  readonly originalIndex: number;
  readonly rank: number;
}

export function prioritizeContext(
  input: readonly ContextFragment[],
): PrioritizedContext | undefined {
  const protectedFragments = input
    .map((fragment, originalIndex) => ({ fragment, originalIndex }))
    .filter(({ fragment }) => fragment.critical)
    .sort(compareProtected)
    .map((value, rank) => Object.freeze({ ...value, rank }));
  if (protectedFragments.length === 0) return;

  const protectedIds = new Set(
    protectedFragments.map(({ fragment }) => fragment.id),
  );
  const middle = input
    .map((fragment, originalIndex) => ({ fragment, originalIndex }))
    .filter(({ fragment }) => !protectedIds.has(fragment.id))
    .sort(compareSupporting);
  const beginning = protectedFragments;
  const end = [...protectedFragments].reverse();

  const occurrences = new Map<string, number>();
  const entries: Array<{
    fragment: ContextFragment;
    placement: ContextPlacement;
  }> = [];
  appendRanked(entries, occurrences, beginning, "beginning");
  for (const value of middle) {
    entries.push({
      fragment: value.fragment,
      placement: placement(value, null, "middle", occurrences),
    });
  }
  appendRanked(entries, occurrences, end, "end");

  const output = Object.freeze(entries.map(({ fragment }) => fragment));
  const placements = Object.freeze(
    entries.map(({ placement: value }) => Object.freeze(value)),
  );
  const inputDigest = digestValue(input.map(({ digest }) => digest));
  const outputDigest = digestValue(
    entries.map(({ fragment, placement: value }) =>
      Object.freeze({ digest: fragment.digest, ...value }),
    ),
  );
  const receiptBody = Object.freeze({
    algorithm: "lost-in-the-middle-bookends-v1" as const,
    inputDigest,
    outputDigest,
    placements,
  });
  return Object.freeze({
    fragments: output,
    receipt: Object.freeze({
      ...receiptBody,
      receiptDigest: digestValue(receiptBody),
    }),
  });
}

function appendRanked(
  output: Array<{ fragment: ContextFragment; placement: ContextPlacement }>,
  occurrences: Map<string, number>,
  values: readonly RankedFragment[],
  region: "beginning" | "end",
): void {
  for (const value of values) {
    output.push({
      fragment: value.fragment,
      placement: placement(value, value.rank, region, occurrences),
    });
  }
}

function placement(
  value: { fragment: ContextFragment; originalIndex: number },
  rank: number | null,
  region: ContextPlacement["region"],
  occurrences: Map<string, number>,
): ContextPlacement {
  const occurrence = occurrences.get(value.fragment.id) ?? 0;
  occurrences.set(value.fragment.id, occurrence + 1);
  return {
    fragmentId: value.fragment.id,
    fragmentDigest: value.fragment.digest,
    originalIndex: value.originalIndex,
    rank,
    region,
    occurrence,
  };
}

function compareProtected(
  left: { fragment: ContextFragment; originalIndex: number },
  right: { fragment: ContextFragment; originalIndex: number },
): number {
  return (
    protectedScore(right.fragment) - protectedScore(left.fragment) ||
    left.fragment.id.localeCompare(right.fragment.id) ||
    left.originalIndex - right.originalIndex
  );
}

function compareSupporting(
  left: { fragment: ContextFragment; originalIndex: number },
  right: { fragment: ContextFragment; originalIndex: number },
): number {
  return (
    right.fragment.priority - left.fragment.priority ||
    left.originalIndex - right.originalIndex
  );
}

function protectedScore(fragment: ContextFragment): number {
  const kindWeight =
    fragment.kind === "contract" ? 300 : fragment.kind === "spec" ? 200 : 100;
  return kindWeight + fragment.priority;
}
