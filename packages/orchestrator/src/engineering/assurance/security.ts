import {
  type IndependentSecurityReviewAuthority,
  isSecurityPolicyLintReceipt,
  isSecurityReviewReceipt,
  type SecurityPolicyLinterAuthority,
  type SecurityPolicyLintReceipt,
  type SecurityReviewReceipt,
} from "@skizzles/change-assurance";
import type { AssuranceEvidence, SecurityEvidence } from "./contract.ts";

export async function reviewAssuranceSecurity(
  linter: SecurityPolicyLinterAuthority,
  reviewer: IndependentSecurityReviewAuthority,
  assurance: AssuranceEvidence,
): Promise<SecurityEvidence | undefined> {
  let lint: Awaited<ReturnType<SecurityPolicyLinterAuthority["lint"]>>;
  try {
    lint = await linter.lint(
      Object.freeze({
        assessment: assurance.input,
        assuranceReceipt: assurance.receipt,
      }),
    );
  } catch {
    return;
  }
  if (
    lint.status !== "completed" ||
    !isSecurityPolicyLintReceipt(lint.receipt) ||
    !verifyLint(linter, assurance, lint.receipt)
  ) {
    return;
  }
  let review: ReturnType<IndependentSecurityReviewAuthority["review"]>;
  try {
    review = reviewer.review(
      Object.freeze({
        assessment: assurance.input,
        assuranceReceipt: assurance.receipt,
        lintReceipt: lint.receipt,
      }),
    );
  } catch {
    return;
  }
  if (
    review.status !== "accepted" ||
    !isSecurityReviewReceipt(review.receipt) ||
    !verifyReview(reviewer, assurance, lint.receipt, review.receipt)
  ) {
    return;
  }
  return Object.freeze({
    lintReceipt: lint.receipt,
    reviewReceipt: review.receipt,
  });
}

export function verifySecurityEvidence(
  linter: SecurityPolicyLinterAuthority,
  reviewer: IndependentSecurityReviewAuthority,
  assurance: AssuranceEvidence,
  evidence: SecurityEvidence,
): boolean {
  return (
    isSecurityPolicyLintReceipt(evidence.lintReceipt) &&
    isSecurityReviewReceipt(evidence.reviewReceipt) &&
    verifyLint(linter, assurance, evidence.lintReceipt) &&
    verifyReview(
      reviewer,
      assurance,
      evidence.lintReceipt,
      evidence.reviewReceipt,
    )
  );
}

function verifyLint(
  linter: SecurityPolicyLinterAuthority,
  assurance: AssuranceEvidence,
  receipt: SecurityPolicyLintReceipt,
): boolean {
  try {
    return linter.verify(
      Object.freeze({
        assessment: assurance.input,
        assuranceReceipt: assurance.receipt,
        receipt,
      }),
    );
  } catch {
    return false;
  }
}

function verifyReview(
  reviewer: IndependentSecurityReviewAuthority,
  assurance: AssuranceEvidence,
  lintReceipt: SecurityPolicyLintReceipt,
  receipt: SecurityReviewReceipt,
): boolean {
  try {
    return reviewer.verify(
      Object.freeze({
        assessment: assurance.input,
        assuranceReceipt: assurance.receipt,
        lintReceipt,
        receipt,
      }),
    );
  } catch {
    return false;
  }
}
