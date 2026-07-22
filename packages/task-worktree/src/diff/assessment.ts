import { digestTaskWorktreeValue } from "../digest.ts";
import type {
  DiffCeilings,
  ExactWorktreeChange,
  ExactWorktreeDiffInput,
  ExactWorktreeDiffMetrics,
  TaskWorktreeDiffReceipt,
  TaskWorktreeFileState,
  TaskWorktreeSlice,
  TaskWorktreeSplitPlan,
} from "./contract.ts";
import {
  changeDigest,
  changeMaterial,
  digestBytes,
  digestFiles,
} from "./input.ts";

export function makeReceipt(
  input: ExactWorktreeDiffInput,
  ceilings: DiffCeilings,
): TaskWorktreeDiffReceipt | undefined {
  const baselineDigest = digestFiles(input.baseline);
  const candidateDigest = digestFiles(input.candidate);
  const computedChanges = computeChanges(
    input.baseline,
    input.candidate,
    ceilings,
  );
  if (computedChanges === undefined) return;
  const changes = Object.freeze(computedChanges);
  const metrics = metricsFor(changes);
  const diffDigest = digestTaskWorktreeValue({
    baselineDigest,
    candidateDigest,
    changes: changes.map(changeMaterial),
    metrics,
  });
  const material = Object.freeze({
    baselineDigest,
    candidateDigest,
    diffDigest,
    metrics,
    changes,
  });
  return Object.freeze({
    ...material,
    receiptDigest: digestTaskWorktreeValue(material),
  });
}

export function makeSplitPlan(
  receipt: TaskWorktreeDiffReceipt,
  ceilings: DiffCeilings,
): TaskWorktreeSplitPlan | undefined {
  const slices: TaskWorktreeSlice[] = [];
  let current: ExactWorktreeChange[] = [];
  for (const change of receipt.changes) {
    if (!fits([change], ceilings)) return;
    if (current.length > 0 && !fits([...current, change], ceilings)) {
      slices.push(makeSlice(slices.length + 1, current));
      current = [];
    }
    current.push(change);
  }
  if (current.length > 0 || receipt.changes.length === 0) {
    slices.push(makeSlice(slices.length + 1, current));
  }
  const frozenSlices = Object.freeze(slices);
  return Object.freeze({
    receiptDigest: receipt.receiptDigest,
    slices: frozenSlices,
    planDigest: digestTaskWorktreeValue({
      receiptDigest: receipt.receiptDigest,
      slices: frozenSlices.map(({ sliceDigest }) => sliceDigest),
    }),
  });
}

function makeSlice(
  id: number,
  changes: readonly ExactWorktreeChange[],
): TaskWorktreeSlice {
  const orderedChanges = Object.freeze([...changes]);
  const paths = Object.freeze(orderedChanges.map(({ path }) => path));
  const changeDigests = Object.freeze(orderedChanges.map(changeDigest));
  const metrics = metricsFor(orderedChanges);
  const material = Object.freeze({
    id: `slice-${id}`,
    paths,
    changeDigests,
    metrics,
  });
  return Object.freeze({
    ...material,
    sliceDigest: digestTaskWorktreeValue(material),
  });
}

function fits(
  changes: readonly ExactWorktreeChange[],
  ceilings: DiffCeilings,
): boolean {
  const metrics = metricsFor(changes);
  return (
    metrics.changedFiles <= ceilings.maxChangedFiles &&
    metrics.addedLines <= ceilings.maxAddedLines &&
    metrics.deletedLines <= ceilings.maxDeletedLines &&
    metrics.changedBytes <= ceilings.maxChangedBytes
  );
}

function computeChanges(
  baseline: readonly TaskWorktreeFileState[],
  candidate: readonly TaskWorktreeFileState[],
  ceilings: DiffCeilings,
): ExactWorktreeChange[] | undefined {
  const baselineByPath = new Map(baseline.map((file) => [file.path, file]));
  const candidateByPath = new Map(candidate.map((file) => [file.path, file]));
  const paths = [
    ...new Set([...baselineByPath.keys(), ...candidateByPath.keys()]),
  ].sort();
  const changes: ExactWorktreeChange[] = [];
  for (const path of paths) {
    const before = baselineByPath.get(path);
    const after = candidateByPath.get(path);
    if (
      before !== undefined &&
      after !== undefined &&
      bytesEqual(before.bytes, after.bytes)
    )
      continue;
    if (ceilings.maxChangedFiles === 0) return;
    const baselineBytes = before?.bytes.length ?? 0;
    const candidateBytes = after?.bytes.length ?? 0;
    if (baselineBytes + candidateBytes > ceilings.maxChangedBytes) return;
    const kind = changeKind(before, after);
    const lineDelta = lineDeltaFor(before?.bytes, after?.bytes, ceilings);
    if (lineDelta === undefined) return;
    changes.push(
      Object.freeze({
        path,
        kind,
        baselineDigest: before === undefined ? null : digestBytes(before.bytes),
        candidateDigest: after === undefined ? null : digestBytes(after.bytes),
        baselineBytes,
        candidateBytes,
        addedLines: lineDelta.added,
        deletedLines: lineDelta.deleted,
        binary: lineDelta.binary,
      }),
    );
  }
  return changes;
}

function lineDeltaFor(
  baseline: readonly number[] | undefined,
  candidate: readonly number[] | undefined,
  ceilings: DiffCeilings,
): Readonly<{ added: number; deleted: number; binary: boolean }> | undefined {
  const before = decodeLines(baseline ?? []);
  const after = decodeLines(candidate ?? []);
  if (before === undefined || after === undefined) {
    return Object.freeze({ added: 0, deleted: 0, binary: true });
  }
  const edits = boundedEditDistance(
    before,
    after,
    ceilings.maxAddedLines + ceilings.maxDeletedLines,
  );
  if (edits === undefined) return;
  const added = (edits + after.length - before.length) / 2;
  const deleted = edits - added;
  if (added > ceilings.maxAddedLines || deleted > ceilings.maxDeletedLines)
    return;
  return Object.freeze({
    added,
    deleted,
    binary: false,
  });
}

function decodeLines(bytes: readonly number[]): readonly string[] | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
    if (text.length === 0) return Object.freeze([]);
    const lines = text
      .split("\n")
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    if (text.endsWith("\n")) lines.pop();
    return Object.freeze(lines);
  } catch {
    return;
  }
}

function bytesEqual(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function boundedEditDistance(
  left: readonly string[],
  right: readonly string[],
  maximumEdits: number,
): number | undefined {
  if (Math.abs(left.length - right.length) > maximumEdits) return;
  let frontier = new Map<number, number>([[1, 0]]);
  for (let edits = 0; edits <= maximumEdits; edits += 1) {
    const next = new Map<number, number>();
    for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
      const advance =
        diagonal === -edits ||
        (diagonal !== edits &&
          (frontier.get(diagonal - 1) ?? -1) <
            (frontier.get(diagonal + 1) ?? -1));
      let leftIndex = advance
        ? (frontier.get(diagonal + 1) ?? 0)
        : (frontier.get(diagonal - 1) ?? 0) + 1;
      let rightIndex = leftIndex - diagonal;
      while (
        leftIndex < left.length &&
        rightIndex < right.length &&
        left[leftIndex] === right[rightIndex]
      ) {
        leftIndex += 1;
        rightIndex += 1;
      }
      if (leftIndex >= left.length && rightIndex >= right.length) return edits;
      next.set(diagonal, leftIndex);
    }
    frontier = next;
  }
  return;
}

function changeKind(
  before: TaskWorktreeFileState | undefined,
  after: TaskWorktreeFileState | undefined,
): "added" | "deleted" | "modified" {
  if (before === undefined) return "added";
  if (after === undefined) return "deleted";
  return "modified";
}

function metricsFor(
  changes: readonly ExactWorktreeChange[],
): ExactWorktreeDiffMetrics {
  return Object.freeze({
    changedFiles: changes.length,
    addedFiles: changes.filter(({ kind }) => kind === "added").length,
    deletedFiles: changes.filter(({ kind }) => kind === "deleted").length,
    addedLines: changes.reduce((total, change) => total + change.addedLines, 0),
    deletedLines: changes.reduce(
      (total, change) => total + change.deletedLines,
      0,
    ),
    baselineBytes: changes.reduce(
      (total, change) => total + change.baselineBytes,
      0,
    ),
    candidateBytes: changes.reduce(
      (total, change) => total + change.candidateBytes,
      0,
    ),
    changedBytes: changes.reduce(
      (total, change) => total + change.baselineBytes + change.candidateBytes,
      0,
    ),
  });
}
