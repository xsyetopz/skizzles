// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import { createCandidateManifest } from "@skizzles/candidate-manifest";
import { type Digest, digestText } from "../../src/digest.ts";
import { validCandidateReceiptBindings } from "../../src/engine/validate.ts";

interface TargetDigestBinding {
  readonly path: string;
  readonly baselineDigest: Digest;
  readonly candidateDigest: Digest;
}

const first = target("src/alpha.ts", "alpha-baseline", "alpha-candidate");
const second = target("src/beta.ts", "beta-baseline", "beta-candidate");

describe("candidate manifest receipt bindings", () => {
  it("rejects reorder, path, content, and mixed drift", () => {
    const canonical = bindings([first, second]);
    expect(validCandidateReceiptBindings(canonical)).toBe(true);

    const reordered = bindings([second, first]);
    expect(reordered.candidateManifestDigest).toBe(
      canonical.candidateManifestDigest,
    );
    expect(reordered.candidateDigest).not.toBe(canonical.candidateDigest);
    expect(validCandidateReceiptBindings(reordered)).toBe(false);

    for (const targets of [
      [Object.freeze({ ...first, path: "src/able.ts" }), second],
      [
        Object.freeze({ ...first, candidateDigest: digestText("drift") }),
        second,
      ],
      [
        Object.freeze({
          ...first,
          path: "src/able.ts",
          candidateDigest: digestText("drift"),
        }),
        second,
      ],
    ]) {
      expect(
        validCandidateReceiptBindings(
          bindings(targets, canonical.candidateManifestDigest),
        ),
      ).toBe(false);
    }
  });
});

function target(
  path: string,
  baseline: string,
  candidate: string,
): TargetDigestBinding {
  return Object.freeze({
    path,
    baselineDigest: digestText(baseline),
    candidateDigest: digestText(candidate),
  });
}

function bindings(
  targetReceipts: readonly TargetDigestBinding[],
  candidateManifestDigest = createCandidateManifest(
    targetReceipts.map(({ path, candidateDigest }) =>
      Object.freeze({
        path,
        operation: "write" as const,
        contentDigest: candidateDigest,
      }),
    ),
  ).manifestDigest,
) {
  const aggregate = (key: "baselineDigest" | "candidateDigest") =>
    digestText(
      JSON.stringify(
        targetReceipts.map((target) => [target.path, target[key]]),
      ),
    );
  return Object.freeze({
    baselineDigest: aggregate("baselineDigest"),
    candidateDigest: aggregate("candidateDigest"),
    candidateManifestDigest,
    targetReceipts: Object.freeze([...targetReceipts]),
  });
}
