import type { VerificationAuthorityRequest } from "@skizzles/acceptance";
import { isRecord } from "../../src/codec.ts";
import { digestValue } from "../../src/digest.ts";
import { createWorkflowVerificationAuthority } from "../../src/workflow/verification/authority.ts";

export function createTestWorkflowVerificationAuthority() {
  const created = createWorkflowVerificationAuthority(
    Object.freeze({
      authorityId: "fixture-verification-gate",
      containerImageDigest: digestValue("fixture-container-image"),
      coverage: Object.freeze({
        minimumNodeHits: 1,
        minimumLineHits: 1,
        minimumBranchHits: 1,
      }),
      fuzz: Object.freeze({
        rootSeed: 7,
        seeds: 1,
        casesPerSeed: 1,
        dimensions: 1,
        minimum: -1,
        maximum: 1,
        extremes: Object.freeze([-1, 0, 1]),
      }),
      limits: Object.freeze({
        modifiedNodes: 64,
        linesPerNode: 64,
        branchesPerNode: 64,
        mutationSitesPerNode: 64,
        variantsPerSite: 64,
        properties: 64,
        artifactBytes: 1_048_576,
      }),
      exclusions: Object.freeze({
        id: "fixture-mutant-exclusions",
        evaluate(request: VerificationAuthorityRequest): unknown {
          const payload = dataRecord(request.payload);
          const mutant = dataRecord(payload?.["mutant"]);
          const mutantId = mutant?.["mutantId"];
          if (typeof mutantId !== "string") {
            return Object.freeze({ status: "rejected" });
          }
          return Object.freeze({
            status: "authorized",
            bindingDigest: request.bindingDigest,
            mutantId,
            classification: "equivalent",
            authorizationDigest: digestValue({
              bindingDigest: request.bindingDigest,
              mutantId,
            }),
          });
        },
      }),
      reviewer: Object.freeze({
        id: "fixture-verification-reviewer",
        evaluate(request: VerificationAuthorityRequest): unknown {
          const payload = dataRecord(request.payload);
          const reviewContextDigest = payload?.["reviewContextDigest"];
          if (typeof reviewContextDigest !== "string") {
            return Object.freeze({ status: "rejected" });
          }
          return Object.freeze({
            status: "accepted",
            bindingDigest: request.bindingDigest,
            reviewContextDigest,
            reviewDigest: digestValue({
              bindingDigest: request.bindingDigest,
              reviewContextDigest,
              decision: "accepted",
            }),
          });
        },
      }),
    }),
  );
  if (created.status !== "created") {
    throw new Error("verification authority fixture rejected");
  }
  return created.authority;
}

function dataRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}
