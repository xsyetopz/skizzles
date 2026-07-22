import { digestBytes, digestText } from "../digest.ts";
import type { SourceLanguageAdapterBindings } from "../language/typescript-contract.ts";
import type { BatchState, BatchTargetState } from "./workflow-state.ts";

export function cloneTarget(target: BatchTargetState): BatchTargetState {
  return {
    ...target,
    astChanges: [...target.astChanges],
    templateReceipts: [...target.templateReceipts],
  };
}

export function commitTargets(
  current: readonly BatchTargetState[],
  candidates: readonly BatchTargetState[],
): void {
  for (let index = 0; index < current.length; index += 1) {
    const target = current[index];
    const candidate = candidates[index];
    if (
      target === undefined ||
      candidate === undefined ||
      target.path !== candidate.path
    ) {
      throw new Error("atomic target set drifted");
    }
    target.candidate = candidate.candidate;
    target.astChanges = candidate.astChanges;
    target.templateReceipts = candidate.templateReceipts;
    target.formatterReceipt = candidate.formatterReceipt;
  }
}

export async function compileEpoch(
  batch: BatchState,
  targets: readonly BatchTargetState[],
  epoch: number,
  epochKind: "edit" | "format",
) {
  const overlays = compilerOverlays(batch.context.adapter, targets);
  if (overlays === undefined) return;
  const candidateSetDigest = digestText(
    JSON.stringify(
      overlays.map(({ path, candidateDigest, semanticDigest }) => ({
        path,
        candidateDigest,
        semanticDigest,
      })),
    ),
  );
  const selected = overlays[0];
  if (selected === undefined) return;
  const predecessor = batch.compilerReceipts.at(-1) ?? null;
  const result = await batch.context.adapter.adapter.validateCandidate({
    requestDigest: batch.request.requestDigest,
    repositoryId: batch.request.repository.id,
    rootIdentity: batch.request.repository.rootIdentity,
    treeDigest: batch.request.repository.treeDigest,
    configDigest: batch.request.repository.configDigest,
    targetPath: selected.path,
    candidateDigest: selected.candidateDigest,
    semanticDigest: selected.semanticDigest,
    epoch,
    epochKind,
    predecessorCandidateSetDigest: batch.candidateSetDigest,
    candidateSetDigest,
    targetSetDigest: batch.targetSetDigest,
    targets: overlays,
    predecessor,
  });
  if (result.status !== "accepted") return;
  return Object.freeze({ receipt: result.receipt, candidateSetDigest });
}

export function candidateSetDigestOf(
  adapter: SourceLanguageAdapterBindings,
  targets: readonly BatchTargetState[],
) {
  const overlays = compilerOverlays(adapter, targets);
  return overlays === undefined
    ? undefined
    : digestText(
        JSON.stringify(
          overlays.map(({ path, candidateDigest, semanticDigest }) => ({
            path,
            candidateDigest,
            semanticDigest,
          })),
        ),
      );
}

function compilerOverlays(
  adapter: SourceLanguageAdapterBindings,
  targets: readonly BatchTargetState[],
) {
  const overlays: Readonly<{
    path: string;
    candidateDigest: import("../digest.ts").Digest;
    semanticDigest: import("../digest.ts").Digest;
    candidateBytes: readonly number[];
  }>[] = [];
  for (const target of targets) {
    const semanticDigest = adapter.adapter.digestSemantics(target.candidate);
    if (semanticDigest === undefined) return;
    const candidateBytes = Object.freeze([
      ...new TextEncoder().encode(target.candidate.text),
    ]);
    overlays.push(
      Object.freeze({
        path: target.path,
        candidateDigest: digestBytes(Uint8Array.from(candidateBytes)),
        semanticDigest,
        candidateBytes,
      }),
    );
  }
  return Object.freeze(overlays);
}
