import { dirname } from "node:path";
import { digestTaskWorktreeBytes, digestTaskWorktreeValue } from "../digest.ts";
import { listWorktrees, pathExists } from "../git/repository.ts";
import { mutate, readSafeFile } from "../lifecycle/candidate/mutation.ts";
import { validateSessionBindings } from "../lifecycle/candidate/validation.ts";
import type { TaskWorktreeSessionBindings } from "../lifecycle/state.ts";
import { captureProtectedManifest } from "../protection/manifest.ts";

export async function verificationView(
  bindings: TaskWorktreeSessionBindings,
  kind: "baseline-tests" | "candidate",
): Promise<
  | Readonly<{
      root: string;
      receiptDigest: ReturnType<typeof digestTaskWorktreeValue>;
    }>
  | undefined
> {
  if (kind === "candidate") {
    const validation = await validateSessionBindings(bindings);
    if (validation === undefined) return;
    return Object.freeze({
      root: bindings.root,
      receiptDigest: digestTaskWorktreeValue({
        kind,
        validation,
        candidateDigest: bindings.candidate.candidateDigest,
        candidateManifestDigest: bindings.candidate.candidateManifestDigest,
        protectedManifest:
          bindings.candidate.protection.candidateManifest.digest,
      }),
    });
  }
  const root = await ensureBaselineView(bindings);
  if (root === undefined) return;
  const validation = await validateBaselineView(bindings, root);
  return validation === undefined
    ? undefined
    : Object.freeze({ root, receiptDigest: validation });
}

async function ensureBaselineView(
  bindings: TaskWorktreeSessionBindings,
): Promise<string | undefined> {
  if (bindings.verification.baselineViewRoot !== null)
    return bindings.verification.baselineViewRoot;
  const root = `${bindings.root}-baseline-tests`;
  if (dirname(root) !== dirname(bindings.root) || (await pathExists(root)))
    return;
  bindings.verification.baselineViewRoot = root;
  const created = await bindings.git.run(bindings.repository.root, [
    "worktree",
    "add",
    "--detach",
    "--",
    root,
    bindings.repository.head,
  ]);
  if (created === undefined) return;
  const protectedPaths = new Set([
    ...bindings.candidate.protection.testPaths,
    ...bindings.candidate.protection.specificationPaths,
  ]);
  for (const change of bindings.input.changes) {
    if (!protectedPaths.has(change.path) && !(await mutate(root, change)))
      return;
  }
  return (await validateBaselineView(bindings, root)) === undefined
    ? undefined
    : root;
}

async function validateBaselineView(
  bindings: TaskWorktreeSessionBindings,
  root: string,
): Promise<ReturnType<typeof digestTaskWorktreeValue> | undefined> {
  const worktrees = await listWorktrees(bindings.git, bindings.repository.root);
  if (
    worktrees === undefined ||
    !worktrees.some(
      (entry) =>
        entry.root === root &&
        entry.head === bindings.repository.head &&
        entry.branch === null,
    )
  )
    return;
  const manifest = await captureProtectedManifest(
    root,
    bindings.protectedPaths,
  );
  if (
    manifest === undefined ||
    manifest.digest !== bindings.candidate.protection.baselineManifest.digest
  )
    return;
  const protectedPaths = new Set([
    ...bindings.candidate.protection.testPaths,
    ...bindings.candidate.protection.specificationPaths,
  ]);
  const productionPaths: string[] = [];
  for (const change of bindings.input.changes) {
    if (protectedPaths.has(change.path)) continue;
    productionPaths.push(change.path);
    const file = await readSafeFile(root, change.path);
    if (change.operation === "delete") {
      if (file.status !== "missing") return;
    } else if (
      file.status !== "present" ||
      change.candidateBytes === null ||
      digestTaskWorktreeBytes(file.bytes) !==
        digestTaskWorktreeBytes(Uint8Array.from(change.candidateBytes))
    )
      return;
  }
  const status = await bindings.git.run(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status === undefined) return;
  const allowed = new Set(productionPaths);
  for (const entry of status.stdout.split("\0").filter(Boolean)) {
    if (!allowed.has(entry.slice(3))) return;
  }
  return digestTaskWorktreeValue({
    kind: "baseline-tests",
    head: bindings.repository.head,
    candidateDigest: bindings.candidate.candidateDigest,
    candidateManifestDigest: bindings.candidate.candidateManifestDigest,
    protectedManifest: manifest.digest,
    productionPaths,
    status: status.stdout,
  });
}
