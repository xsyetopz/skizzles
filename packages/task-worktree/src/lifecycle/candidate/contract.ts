import type { AtomicTaskSliceCommitReceipt } from "../../commit/contract.ts";
import type { TaskWorktreeFailureCode } from "../../contract.ts";
import type {
  ExactWorktreeDiffInput,
  TaskWorktreeDiffReceipt,
  TaskWorktreeSplitPlan,
} from "../../diff/contract.ts";
import type { TaskWorktreeDigest } from "../../digest.ts";
import type { ProtectedCandidateState } from "../../protection/contract.ts";
import type { PortableSandboxReceipt } from "../../sandbox/capabilities.ts";

export interface PreparedCandidate {
  readonly diffInput: ExactWorktreeDiffInput;
  readonly diffReceipt: TaskWorktreeDiffReceipt;
  readonly commitReceipt: AtomicTaskSliceCommitReceipt;
  readonly candidateDigest: TaskWorktreeDigest;
  readonly candidateManifestDigest: TaskWorktreeDigest;
  readonly assuranceDigest: TaskWorktreeDigest;
  readonly sandboxReceipt: PortableSandboxReceipt;
  readonly dependencyDigest: TaskWorktreeDigest;
  readonly phasePlanDigest: TaskWorktreeDigest;
  readonly protection: ProtectedCandidateState;
  committedHead: string | null;
}

export interface CandidateDependencyInterventionDiagnostic {
  readonly kind: "dependency";
  readonly request: Readonly<{
    ecosystem: "npm";
    name: string;
    requestedRange: string;
  }> | null;
  readonly outcome: "mismatch" | "unavailable" | "rejected";
  readonly code: string | null;
  readonly warning: string | null;
  readonly receiptDigest: string | null;
}

export type CandidatePreparationResult =
  | Readonly<{ status: "prepared"; candidate: PreparedCandidate }>
  | Readonly<{ status: "split-required"; plan: TaskWorktreeSplitPlan }>
  | Readonly<{
      status: "intervention-required";
      diagnostics: readonly CandidateDependencyInterventionDiagnostic[];
    }>
  | Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }>;
