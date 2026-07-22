import type { TaskWorktreePrepareInput } from "../../contract.ts";
import type { ExactWorktreeDiffInput } from "../../diff/contract.ts";
import { digestTaskWorktreeBytes } from "../../digest.ts";
import { readSafeFile } from "./mutation.ts";

export async function currentCandidateInput(
  root: string,
  declaration: TaskWorktreePrepareInput,
  baseline: ExactWorktreeDiffInput["baseline"],
): Promise<ExactWorktreeDiffInput | undefined> {
  const candidate = await captureCandidate(root, declaration);
  return candidate === undefined
    ? undefined
    : Object.freeze({ baseline, candidate });
}

export async function captureBaseline(
  root: string,
  input: TaskWorktreePrepareInput,
): Promise<ExactWorktreeDiffInput["baseline"] | undefined> {
  const files: { path: string; bytes: readonly number[] }[] = [];
  for (const change of input.changes) {
    const read = await readSafeFile(root, change.path);
    if (read.status === "unsafe") return;
    if (read.status === "missing") {
      if (change.baselineDigest !== null) return;
      continue;
    }
    if (change.baselineDigest !== digestTaskWorktreeBytes(read.bytes)) return;
    files.push(
      Object.freeze({
        path: change.path,
        bytes: Object.freeze(Array.from(read.bytes)),
      }),
    );
  }
  return Object.freeze(files);
}

export async function captureCandidate(
  root: string,
  input: TaskWorktreePrepareInput,
): Promise<ExactWorktreeDiffInput["candidate"] | undefined> {
  const files: { path: string; bytes: readonly number[] }[] = [];
  for (const change of input.changes) {
    const read = await readSafeFile(root, change.path);
    if (read.status === "unsafe") return;
    if (read.status === "missing") {
      if (change.operation !== "delete") return;
      continue;
    }
    if (change.operation === "delete") return;
    if (change.candidateBytes === null) return;
    if (
      digestTaskWorktreeBytes(read.bytes) !==
      digestTaskWorktreeBytes(Uint8Array.from(change.candidateBytes))
    )
      return;
    files.push(
      Object.freeze({
        path: change.path,
        bytes: Object.freeze(Array.from(read.bytes)),
      }),
    );
  }
  return Object.freeze(files);
}
