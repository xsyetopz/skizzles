import type {
  DeterministicFuzzConfig,
  VerificationAuthorityRequest,
  VerificationCoverageThresholds,
  VerificationGateFailureCode,
  VerificationGateLimits,
  VerificationGateReceipt,
  VerificationGateVerifyResult,
} from "@skizzles/acceptance";
import type {
  ChangeAssurance,
  ChangeAssuranceAssessmentInput,
  ChangeAssuranceReceipt,
  IndependentSecurityReviewAuthority,
  SecurityPolicyLinterAuthority,
  SecurityPolicyLintReceipt,
  SecurityReviewReceipt,
} from "@skizzles/change-assurance";
import type {
  SourceEngineering,
  StructuralEvidenceReceipt,
} from "@skizzles/source-transformation";
import type {
  TaskWorktree,
  TaskWorktreeSession,
} from "@skizzles/task-worktree";
import type { Digest } from "../../digest.ts";
import type {
  WorkflowTaskVerificationReceipts,
  WorkflowVerificationObjectives,
} from "./task-contract.ts";

export interface WorkflowVerificationDecisionPort {
  readonly id: string;
  readonly evaluate: (
    request: VerificationAuthorityRequest,
  ) => unknown | Promise<unknown>;
}

export interface WorkflowVerificationAuthorityConfig {
  readonly authorityId: string;
  readonly containerImageDigest: Digest;
  readonly coverage: VerificationCoverageThresholds;
  readonly fuzz: DeterministicFuzzConfig;
  readonly limits: VerificationGateLimits;
  readonly exclusions: WorkflowVerificationDecisionPort;
  readonly reviewer: WorkflowVerificationDecisionPort;
}

export type WorkflowPhysicalVerificationEvidence =
  | Readonly<{
      mode: "not-applicable";
      declarationDigests: readonly [];
    }>
  | Readonly<{
      mode: "attested";
      candidateDigest: Digest;
      isolationDigest: Digest;
      declarationDigests: readonly Digest[];
      receiptDigests: readonly Digest[];
      verify: () => boolean | Promise<boolean>;
    }>;

export interface WorkflowVerificationMaterialInput {
  readonly source: Readonly<{
    authority: SourceEngineering;
    artifacts: readonly object[];
    receipt: object;
    summary: Readonly<{
      requestDigest: Digest;
      candidateDigest: Digest;
      provenanceDigest: Digest;
      validationDigest: Digest;
      compilerReceiptDigest: Digest;
      candidateManifestDigest: Digest;
      structuralReceipt: StructuralEvidenceReceipt;
    }>;
  }>;
  readonly changeAssurance: Readonly<{
    authority: ChangeAssurance;
    assessment: ChangeAssuranceAssessmentInput;
    receipt: ChangeAssuranceReceipt;
    linter: SecurityPolicyLinterAuthority;
    lintReceipt: SecurityPolicyLintReceipt;
    reviewer: IndependentSecurityReviewAuthority;
    reviewReceipt: SecurityReviewReceipt;
  }>;
  readonly physical: WorkflowPhysicalVerificationEvidence;
}

export interface WorkflowVerificationMaterial {
  readonly schema: "skizzles.orchestrator/workflow-verification-material";
}

export interface WorkflowVerificationBindings {
  readonly taskId: string;
  readonly taskEpochDigest: Digest;
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: Digest;
  readonly baselineDigest: Digest;
  readonly candidateDigest: Digest;
  readonly candidateManifestDigest: Digest;
  readonly specLockDigest: Digest;
  readonly baselineManifestDigest: Digest;
}

export interface WorkflowVerificationEvaluationInput {
  readonly bindings: WorkflowVerificationBindings;
  readonly material: WorkflowVerificationMaterial;
  readonly taskWorktree: TaskWorktree;
  readonly session: TaskWorktreeSession;
  readonly receipts: WorkflowTaskVerificationReceipts;
}

export interface WorkflowVerificationEvidence {
  readonly input: object;
  readonly receipt: VerificationGateReceipt;
}

export type WorkflowVerificationEvaluationResult =
  | Readonly<{
      status: "accepted";
      evidence: WorkflowVerificationEvidence;
    }>
  | Readonly<{
      status: "rejected";
      code: VerificationGateFailureCode;
      failures: readonly VerificationGateFailureCode[];
    }>;

export interface WorkflowVerificationAuthority {
  readonly schema: "skizzles.orchestrator/workflow-verification-authority";
  readonly issue: (
    input: WorkflowVerificationMaterialInput,
  ) => WorkflowVerificationMaterial | undefined;
  readonly deriveObjectives: (
    material: WorkflowVerificationMaterial,
  ) => WorkflowVerificationObjectives | undefined;
  readonly evaluate: (
    input: WorkflowVerificationEvaluationInput,
  ) => Promise<WorkflowVerificationEvaluationResult>;
  readonly verify: (
    evidence: WorkflowVerificationEvidence,
  ) => Promise<VerificationGateVerifyResult>;
}

export type WorkflowVerificationAuthorityCreationResult =
  | Readonly<{
      status: "created";
      authority: WorkflowVerificationAuthority;
    }>
  | Readonly<{ status: "rejected"; code: "INVALID_CONFIG" }>;
