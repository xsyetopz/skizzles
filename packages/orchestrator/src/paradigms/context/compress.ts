import { digestValue } from "../../digest.ts";
import type {
  CompressionDecision,
  CompressionReceipt,
  ContextFragment,
  ContextPlacement,
} from "./contract.ts";

const whitespacePattern = /\s+/gu;

export interface CompressedContext {
  readonly sections: readonly string[];
  readonly receipt: CompressionReceipt;
}

interface CompressionEntry {
  readonly fragment: ContextFragment;
  readonly placement: ContextPlacement;
  content: string | null;
  action: CompressionDecision["action"];
  reason: CompressionDecision["reason"];
}

export function estimateTokens(content: string): number {
  return Math.ceil(new TextEncoder().encode(content).byteLength / 4);
}

export function compressContext(
  fragments: readonly ContextFragment[],
  placements: readonly ContextPlacement[],
  targetTokenEstimate: number,
): CompressedContext | undefined {
  if (fragments.length !== placements.length) return;
  const entries: CompressionEntry[] = [];
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    const placement = placements[index];
    if (fragment === undefined || placement === undefined) return;
    const compressed = fragment.critical
      ? fragment.content
      : collapseWhitespace(fragment.content);
    entries.push({
      fragment,
      placement,
      content: compressed,
      action:
        compressed === fragment.content ? "preserved" : "whitespace-collapsed",
      reason: fragment.critical
        ? "protected-fragment"
        : compressed === fragment.content
          ? "within-token-target"
          : "whitespace-reduction",
    });
  }

  const beforeTokenEstimate = sumTokens(
    entries.map(({ fragment }) => fragment.content),
  );
  let afterTokenEstimate = sumTokens(
    entries.flatMap(({ content }) => (content === null ? [] : [content])),
  );
  const omissionOrder = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !entry.fragment.critical)
    .sort(
      (left, right) =>
        left.entry.fragment.priority - right.entry.fragment.priority ||
        right.index - left.index,
    );
  for (const { entry } of omissionOrder) {
    if (afterTokenEstimate <= targetTokenEstimate) break;
    if (entry.content === null) return;
    afterTokenEstimate -= estimateTokens(entry.content);
    entry.content = null;
    entry.action = "omitted";
    entry.reason = "token-target";
  }
  if (afterTokenEstimate > targetTokenEstimate) return;

  const decisions = Object.freeze(
    entries.map((entry) => {
      const content = entry.content;
      return Object.freeze({
        fragmentId: entry.fragment.id,
        occurrence: entry.placement.occurrence,
        action: entry.action,
        reason: entry.reason,
        beforeTokenEstimate: estimateTokens(entry.fragment.content),
        afterTokenEstimate: content === null ? 0 : estimateTokens(content),
        beforeDigest: digestValue(entry.fragment.content),
        afterDigest: content === null ? null : digestValue(content),
      });
    }),
  );
  const sections = Object.freeze(
    entries.flatMap(({ content }) => (content === null ? [] : [content])),
  );
  const inputDigest = digestValue(
    entries.map(({ fragment, placement }) =>
      Object.freeze({ digest: fragment.digest, placement }),
    ),
  );
  const outputDigest = digestValue(sections);
  const decisionsDigest = digestValue(decisions);
  const receiptBody = Object.freeze({
    algorithm: "auditable-context-compression-v1" as const,
    estimator: "utf8-bytes-ceiling-divided-by-four-v1" as const,
    targetTokenEstimate,
    beforeTokenEstimate,
    afterTokenEstimate,
    inputDigest,
    outputDigest,
    decisions,
    decisionsDigest,
  });
  return Object.freeze({
    sections,
    receipt: Object.freeze({
      ...receiptBody,
      receiptDigest: digestValue(receiptBody),
    }),
  });
}

function collapseWhitespace(content: string): string {
  return content.replace(whitespacePattern, " ").trim();
}

function sumTokens(contents: readonly string[]): number {
  let total = 0;
  for (const content of contents) total += estimateTokens(content);
  return total;
}
