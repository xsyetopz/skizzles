import type { CandidateManifestDigest } from "@skizzles/candidate-manifest";
import type {
  ChangeAssurance,
  ChangeAssuranceAssessmentInput,
  ChangeAssuranceReceipt,
} from "../../contract.ts";
import type {
  SecurityDigest,
  SecurityFinding,
  SecurityPolicyConfig,
} from "../contract.ts";

export interface SecurityPolicyLintFinding extends SecurityFinding {
  readonly candidateDigest: SecurityDigest;
}

export interface SecurityPolicyLintReceipt {
  readonly status: "clear" | "findings";
  readonly authorityId: string;
  readonly requestDigest: SecurityDigest;
  readonly repositoryId: string;
  readonly treeDigest: SecurityDigest;
  readonly baselineDigest: SecurityDigest;
  readonly declarationDigest: SecurityDigest;
  readonly targetSetDigest: SecurityDigest;
  readonly candidateDigest: SecurityDigest;
  readonly candidateManifestDigest: CandidateManifestDigest;
  readonly assuranceReceiptDigest: SecurityDigest;
  readonly securityEvidenceDigest: SecurityDigest;
  readonly policyDigest: SecurityDigest;
  readonly findings: readonly SecurityPolicyLintFinding[];
  readonly receiptDigest: SecurityDigest;
}

export interface SecurityPolicyLintInput {
  readonly assessment: ChangeAssuranceAssessmentInput;
  readonly assuranceReceipt: ChangeAssuranceReceipt;
}

export type SecurityPolicyLintResult =
  | Readonly<{ status: "completed"; receipt: SecurityPolicyLintReceipt }>
  | Readonly<{
      status: "halted";
      code:
        | "INVALID_LINT_INPUT"
        | "ASSURANCE_BINDING_REJECTED"
        | "SECURITY_ANALYSIS_REJECTED";
    }>;

export interface SecurityPolicyLinterAuthority {
  readonly kind: "security-policy-linter";
  readonly authorityId: string;
  readonly policyDigest: SecurityDigest;
  readonly lint: (input: unknown) => Promise<SecurityPolicyLintResult>;
  readonly verify: (input: unknown) => boolean;
}

export interface SecurityPolicyLinterConfig {
  readonly authorityId: string;
  readonly assurance: ChangeAssurance;
  readonly policy: SecurityPolicyConfig;
}

export type SecurityPolicyLinterCreationResult =
  | Readonly<{
      status: "created";
      authority: SecurityPolicyLinterAuthority;
    }>
  | Readonly<{ status: "rejected"; code: "INVALID_LINTER_CONFIG" }>;

export interface SecurityReviewInput extends SecurityPolicyLintInput {
  readonly lintReceipt: SecurityPolicyLintReceipt;
}

export interface SecurityReviewReceipt {
  readonly status: "accepted" | "halted";
  readonly authorityId: string;
  readonly linterAuthorityId: string;
  readonly assuranceReceiptDigest: SecurityDigest;
  readonly lintReceiptDigest: SecurityDigest;
  readonly policyDigest: SecurityDigest;
  readonly candidateDigest: SecurityDigest;
  readonly candidateManifestDigest: CandidateManifestDigest;
  readonly blockingFindingFingerprints: readonly SecurityDigest[];
  readonly receiptDigest: SecurityDigest;
}

export type SecurityReviewResult =
  | Readonly<{ status: "accepted"; receipt: SecurityReviewReceipt }>
  | Readonly<{
      status: "halted";
      code:
        | "INVALID_REVIEW_INPUT"
        | "SECURITY_REVIEW_BINDING_REJECTED"
        | "HIGH_RISK_FINDING";
      receipt?: SecurityReviewReceipt;
    }>;

export interface IndependentSecurityReviewAuthority {
  readonly kind: "independent-security-review";
  readonly authorityId: string;
  readonly review: (input: unknown) => SecurityReviewResult;
  readonly verify: (input: unknown) => boolean;
}

export interface IndependentSecurityReviewConfig {
  readonly authorityId: string;
  readonly assurance: ChangeAssurance;
  readonly linter: SecurityPolicyLinterAuthority;
}

export type IndependentSecurityReviewCreationResult =
  | Readonly<{
      status: "created";
      authority: IndependentSecurityReviewAuthority;
    }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_REVIEW_AUTHORITY_CONFIG";
    }>;
