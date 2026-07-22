import { createCandidateManifest } from "@skizzles/candidate-manifest";
import type { TaskWorktreePrepareInput } from "../../contract.ts";
import type { ExactWorktreeDiffInput } from "../../diff/contract.ts";
import type { TaskWorktreeDigest } from "../../digest.ts";
import { digestTaskWorktreeBytes } from "../../digest.ts";

export function candidateManifestDigest(
  input: TaskWorktreePrepareInput,
  candidate: ExactWorktreeDiffInput["candidate"],
): TaskWorktreeDigest | undefined {
  try {
    const files = new Map(candidate.map((file) => [file.path, file.bytes]));
    const entries = input.changes.map(({ path, operation }) => {
      const bytes = files.get(path);
      if (operation === "delete") {
        if (bytes !== undefined)
          throw new TypeError("deleted candidate exists");
        return Object.freeze({ path, operation, contentDigest: null });
      }
      if (bytes === undefined)
        throw new TypeError("written candidate is missing");
      return Object.freeze({
        path,
        operation,
        contentDigest: digestTaskWorktreeBytes(Uint8Array.from(bytes)),
      });
    });
    if (
      files.size !==
      entries.filter(({ operation }) => operation === "write").length
    )
      return;
    return createCandidateManifest(entries).manifestDigest;
  } catch {
    return;
  }
}
