import type {
  ChangeAssuranceAssessmentInput,
  ChangeAssuranceReceipt,
  SecurityPolicyLintReceipt,
  SecurityReviewReceipt,
} from "@skizzles/change-assurance";

export interface AssuranceEvidence {
  readonly receipt: ChangeAssuranceReceipt;
  readonly input: ChangeAssuranceAssessmentInput;
}

export interface SecurityEvidence {
  readonly lintReceipt: SecurityPolicyLintReceipt;
  readonly reviewReceipt: SecurityReviewReceipt;
}
