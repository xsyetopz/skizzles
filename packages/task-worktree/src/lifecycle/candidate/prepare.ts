import type { TaskWorktreeCommitAuthority } from "../../commit/contract.ts";
import type {
  TaskWorktreeFailureCode,
  TaskWorktreePrepareInput,
} from "../../contract.ts";
import type { DependencyResolutionService } from "../../dependency/resolution.ts";
import type { TaskWorktreeDiffAuthority } from "../../diff/contract.ts";
import { digestTaskWorktreeValue } from "../../digest.ts";
import {
  createCandidateMutationGateway,
  createPathInspectionAuthority,
} from "../../policy/path-scope.ts";
import type { PortableSandboxBroker } from "../../sandbox/capabilities.ts";
import { captureBaseline, captureCandidate } from "./capture.ts";
import type {
  CandidateDependencyInterventionDiagnostic,
  CandidatePreparationResult,
} from "./contract.ts";
import { inspectTarget, mutate } from "./mutation.ts";

export async function prepareCandidate(
  input: Readonly<{
    root: string;
    declaration: TaskWorktreePrepareInput;
    diffAuthority: TaskWorktreeDiffAuthority;
    commitAuthority: TaskWorktreeCommitAuthority;
    sandbox: PortableSandboxBroker;
    sandboxWritePaths: readonly string[];
    dependencies: DependencyResolutionService;
    dependencyRequests: readonly unknown[];
  }>,
): Promise<CandidatePreparationResult> {
  // The candidate declaration is never used as a sandbox capability request.
  // Only the host configuration's relative writable roots cross this boundary.
  const sandbox = await input.sandbox.negotiate(input.sandboxWritePaths);
  if (sandbox.status !== "accepted") return rejected("SANDBOX_REJECTED");

  const dependencyDigests: string[] = [];
  const interventionDiagnostics: CandidateDependencyInterventionDiagnostic[] =
    [];
  for (const request of input.dependencyRequests) {
    const result = await input.dependencies.resolve(request);
    if (result.status !== "resolved") {
      interventionDiagnostics.push(
        Object.freeze({
          kind: "dependency",
          request: null,
          outcome: "rejected",
          code: result.code,
          warning:
            "dependency resolver could not produce an authentic registry receipt",
          receiptDigest: null,
        }),
      );
      continue;
    }
    dependencyDigests.push(result.receipt.receiptDigest);
    if (result.receipt.outcome !== "matched") {
      interventionDiagnostics.push(
        Object.freeze({
          kind: "dependency",
          request: result.receipt.request,
          outcome: result.receipt.outcome,
          code: null,
          warning: result.receipt.warning,
          receiptDigest: result.receipt.receiptDigest,
        }),
      );
    }
  }
  if (interventionDiagnostics.length > 0) {
    return Object.freeze({
      status: "intervention-required",
      diagnostics: Object.freeze(interventionDiagnostics),
    });
  }

  const baseline = await captureBaseline(input.root, input.declaration);
  if (baseline === undefined) return rejected("BASELINE_MISMATCH");
  const pathAuthority = createPathInspectionAuthority(
    Object.freeze({
      id: `worktree:${digestTaskWorktreeValue(input.root)}`,
      inspect: async (path: string) => {
        const safe = await inspectTarget(input.root, path);
        if (!safe) throw new Error("unsafe candidate path");
        return Object.freeze({
          requestedPath: path,
          resolvedPath: path,
          symlinkEncountered: false,
        });
      },
    }),
  );
  if (pathAuthority.status !== "created") return rejected("CANDIDATE_REJECTED");
  const gateway = createCandidateMutationGateway(
    Object.freeze({
      targets: Object.freeze(
        input.declaration.changes.map(({ path, operation }) =>
          Object.freeze({ path, operation }),
        ),
      ),
      pathAuthority: pathAuthority.authority,
    }),
  );
  if (gateway.status !== "created") return rejected("CANDIDATE_REJECTED");
  for (const change of input.declaration.changes) {
    const authorization = await gateway.gateway.authorize(
      Object.freeze({
        path: change.path,
        operation: change.operation,
        candidateBytes: change.candidateBytes ?? undefined,
      }),
    );
    if (
      authorization.status !== "authorized" ||
      !(await mutate(input.root, change))
    ) {
      return rejected("CANDIDATE_REJECTED");
    }
  }
  const candidate = await captureCandidate(input.root, input.declaration);
  if (candidate === undefined) return rejected("CANDIDATE_REJECTED");
  const diffInput = Object.freeze({ baseline, candidate });
  const diff = input.diffAuthority.inspect(diffInput);
  if (diff.status === "rejected") return rejected("DIFF_REJECTED");
  if (diff.status === "split-required") {
    return Object.freeze({ status: "split-required", plan: diff.plan });
  }
  if (
    !input.diffAuthority.verify(
      Object.freeze({ input: diffInput, receipt: diff.receipt }),
    )
  ) {
    return rejected("DIFF_REJECTED");
  }
  const slice = diff.plan.slices[0];
  if (slice === undefined) return rejected("DIFF_REJECTED");
  const commit = input.commitAuthority.prepare(
    Object.freeze({ receipt: diff.receipt, slice }),
  );
  if (
    commit.status !== "prepared" ||
    !input.commitAuthority.verify(
      Object.freeze({
        input: Object.freeze({ receipt: diff.receipt, slice }),
        receipt: commit.receipt,
      }),
    )
  ) {
    return rejected("COMMIT_REJECTED");
  }
  return Object.freeze({
    status: "prepared",
    candidate: {
      diffInput,
      diffReceipt: diff.receipt,
      commitReceipt: commit.receipt,
      candidateDigest: diff.receipt.candidateDigest,
      assuranceDigest: digestTaskWorktreeValue({
        sandbox: sandbox.receipt.receiptDigest,
        dependencies: dependencyDigests,
        diff: diff.receipt.receiptDigest,
        commit: commit.receipt.receiptDigest,
      }),
      sandboxReceipt: sandbox.receipt,
      dependencyDigest: digestTaskWorktreeValue(dependencyDigests),
      phasePlanDigest: diff.plan.planDigest,
      committedHead: null,
    },
  });
}

function rejected(
  code: TaskWorktreeFailureCode,
): Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }> {
  return Object.freeze({ status: "rejected", code });
}
