import type { TaskWorktreeDigest } from "../../digest.ts";
import { digestTaskWorktreeValue } from "../../digest.ts";
import { captureProtectedManifest } from "../../protection/manifest.ts";
import {
  inspectAllocation,
  type TaskWorktreeSessionBindings,
} from "../state.ts";
import { currentCandidateInput } from "./capture.ts";
import { candidateManifestDigest } from "./manifest.ts";

export async function validateSessionBindings(
  bindings: TaskWorktreeSessionBindings,
): Promise<TaskWorktreeDigest | undefined> {
  const allocation = await inspectAllocation(bindings);
  if (allocation === undefined || !allocation.registered) return;
  const current = await currentCandidateInput(
    bindings.root,
    bindings.input,
    bindings.candidate.diffInput.baseline,
  );
  if (
    current === undefined ||
    candidateManifestDigest(bindings.input, current.candidate) !==
      bindings.candidate.candidateManifestDigest ||
    !bindings.diffAuthority.verify(
      Object.freeze({
        input: current,
        receipt: bindings.candidate.diffReceipt,
      }),
    )
  )
    return;
  const protectedManifest = await captureProtectedManifest(
    bindings.root,
    bindings.protectedPaths,
  );
  if (
    protectedManifest === undefined ||
    protectedManifest.digest !==
      bindings.candidate.protection.candidateManifest.digest
  )
    return;
  const status = await bindings.git.run(bindings.root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status === undefined) return;
  const allowed = new Set(bindings.input.changes.map(({ path }) => path));
  for (const entry of status.stdout.split("\0").filter(Boolean)) {
    if (!allowed.has(entry.slice(3))) return;
  }
  if (
    bindings.candidate.committedHead !== null &&
    (status.stdout.length !== 0 ||
      allocation.head !== bindings.candidate.committedHead)
  )
    return;
  return digestTaskWorktreeValue({
    prepare: bindings.prepareDigest,
    candidate: bindings.candidate.candidateDigest,
    candidateManifest: bindings.candidate.candidateManifestDigest,
    head: allocation.head,
    status: status.stdout,
  });
}
