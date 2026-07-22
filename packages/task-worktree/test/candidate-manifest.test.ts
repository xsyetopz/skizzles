// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { describe, expect, it } from "bun:test";

import { createCandidateManifest } from "@skizzles/candidate-manifest";
import type {
  TaskWorktreeChange,
  TaskWorktreePrepareInput,
} from "../src/contract.ts";
import type { TaskWorktreeFileState } from "../src/diff/contract.ts";
import {
  digestTaskWorktreeBytes,
  digestTaskWorktreeValue,
} from "../src/digest.ts";
import { candidateManifestDigest } from "../src/lifecycle/candidate/manifest.ts";

describe("candidate file-manifest binding", () => {
  it("matches the canonical owner and distinguishes bytes, paths, and deletes", () => {
    const alpha = change("alpha.ts", "alpha\n");
    const beta = change("beta.ts", "beta\n");
    const candidate = Object.freeze([
      file("alpha.ts", "alpha\n"),
      file("beta.ts", "beta\n"),
    ]);
    const digest = candidateManifestDigest(
      prepareInput(Object.freeze([alpha, beta])),
      candidate,
    );
    expect(digest).toBe(
      createCandidateManifest([
        {
          path: "alpha.ts",
          operation: "write",
          contentDigest: digestTaskWorktreeBytes(bytes("alpha\n")),
        },
        {
          path: "beta.ts",
          operation: "write",
          contentDigest: digestTaskWorktreeBytes(bytes("beta\n")),
        },
      ]).manifestDigest,
    );
    expect(
      candidateManifestDigest(
        prepareInput(Object.freeze([beta, alpha])),
        Object.freeze([...candidate].reverse()),
      ),
    ).toBe(digest);
    expect(
      candidateManifestDigest(
        prepareInput(Object.freeze([alpha, beta])),
        Object.freeze([file("alpha.ts", "drift\n"), file("beta.ts", "beta\n")]),
      ),
    ).not.toBe(digest);
    expect(
      candidateManifestDigest(
        prepareInput(Object.freeze([alpha, change("gamma.ts", "beta\n")])),
        Object.freeze([
          file("alpha.ts", "alpha\n"),
          file("gamma.ts", "beta\n"),
        ]),
      ),
    ).not.toBe(digest);
    expect(
      candidateManifestDigest(
        prepareInput(
          Object.freeze([
            alpha,
            Object.freeze({
              ...beta,
              operation: "delete" as const,
              candidateBytes: null,
            }),
          ]),
        ),
        Object.freeze([file("alpha.ts", "alpha\n")]),
      ),
    ).not.toBe(digest);
  });
});

function change(path: string, content: string): TaskWorktreeChange {
  return Object.freeze({
    path,
    operation: "write" as const,
    baselineDigest: null,
    candidateBytes: Object.freeze([...bytes(content)]),
  });
}

function file(path: string, content: string): TaskWorktreeFileState {
  return Object.freeze({ path, bytes: Object.freeze([...bytes(content)]) });
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function prepareInput(
  changes: readonly TaskWorktreeChange[],
): TaskWorktreePrepareInput {
  const digest = digestTaskWorktreeValue("fixture");
  return Object.freeze({
    taskId: "candidate-manifest",
    taskEpochDigest: digest,
    requestDigest: digest,
    repositoryId: "repo-a",
    rootIdentity: "root-a",
    treeDigest: digest,
    baselineDigest: digest,
    changes,
  });
}
