import type {
  ChangeAssurance,
  ChangeAssuranceAssessmentInput,
  ChangeAssuranceReceipt,
} from "../../contract.ts";
import { digestValue } from "../../digest.ts";
import { isChangeAssurance } from "../../runtime.ts";
import type {
  IndependentSecurityReviewAuthority,
  IndependentSecurityReviewCreationResult,
  SecurityPolicyLinterAuthority,
  SecurityPolicyLintReceipt,
  SecurityReviewInput,
  SecurityReviewReceipt,
  SecurityReviewResult,
} from "./contract.ts";
import { assessmentDigest, authorityId, exactFrozenRecord } from "./input.ts";
import { isSecurityPolicyLinter } from "./linter.ts";

interface ReviewState {
  readonly assurance: ChangeAssurance;
  readonly linter: SecurityPolicyLinterAuthority;
}

interface ReceiptState {
  readonly owner: IndependentSecurityReviewAuthority;
  readonly inputDigest: ReturnType<typeof digestValue>;
}

const authorities = new WeakMap<object, ReviewState>();
const receipts = new WeakMap<object, ReceiptState>();

export function createIndependentSecurityReviewAuthority(
  input: unknown,
): IndependentSecurityReviewCreationResult {
  const record = exactFrozenRecord(input, [
    "authorityId",
    "assurance",
    "linter",
  ]);
  const parsedAuthorityId = authorityId(record?.get("authorityId"));
  const assurance = record?.get("assurance");
  const linter = record?.get("linter");
  if (
    record === undefined ||
    parsedAuthorityId === undefined ||
    !isChangeAssurance(assurance) ||
    !isSecurityPolicyLinter(linter) ||
    parsedAuthorityId === linter.authorityId
  )
    return Object.freeze({
      status: "rejected",
      code: "INVALID_REVIEW_AUTHORITY_CONFIG",
    });
  let authority: IndependentSecurityReviewAuthority;
  authority = Object.freeze({
    kind: "independent-security-review",
    authorityId: parsedAuthorityId,
    review: (value: unknown) => review(authority, value),
    verify: (value: unknown) => verify(authority, value),
  });
  authorities.set(authority, { assurance, linter });
  return Object.freeze({ status: "created", authority });
}

export function isIndependentSecurityReviewAuthority(
  value: unknown,
): value is IndependentSecurityReviewAuthority {
  return typeof value === "object" && value !== null && authorities.has(value);
}

export function isSecurityReviewReceipt(
  value: unknown,
): value is SecurityReviewReceipt {
  return typeof value === "object" && value !== null && receipts.has(value);
}

function review(
  authority: IndependentSecurityReviewAuthority,
  value: unknown,
): SecurityReviewResult {
  const state = authorities.get(authority);
  const input = parseReviewInput(value);
  if (state === undefined || input === undefined)
    return Object.freeze({ status: "halted", code: "INVALID_REVIEW_INPUT" });
  if (!bindingsValid(state, input))
    return Object.freeze({
      status: "halted",
      code: "SECURITY_REVIEW_BINDING_REJECTED",
    });
  const blocking = input.lintReceipt.findings
    .map(({ fingerprint }) => fingerprint)
    .sort((left, right) => left.localeCompare(right));
  const material = Object.freeze({
    status: blocking.length === 0 ? ("accepted" as const) : ("halted" as const),
    authorityId: authority.authorityId,
    linterAuthorityId: state.linter.authorityId,
    assuranceReceiptDigest: input.assuranceReceipt.receiptDigest,
    lintReceiptDigest: input.lintReceipt.receiptDigest,
    policyDigest: input.lintReceipt.policyDigest,
    candidateDigest: input.lintReceipt.candidateDigest,
    candidateManifestDigest: input.lintReceipt.candidateManifestDigest,
    blockingFindingFingerprints: Object.freeze(blocking),
  });
  const receipt: SecurityReviewReceipt = Object.freeze({
    ...material,
    receiptDigest: digestValue(material),
  });
  receipts.set(receipt, {
    owner: authority,
    inputDigest: reviewInputDigest(input),
  });
  return blocking.length === 0
    ? Object.freeze({ status: "accepted", receipt })
    : Object.freeze({
        status: "halted",
        code: "HIGH_RISK_FINDING",
        receipt,
      });
}

function verify(
  authority: IndependentSecurityReviewAuthority,
  value: unknown,
): boolean {
  try {
    const record = exactFrozenRecord(value, [
      "assessment",
      "assuranceReceipt",
      "lintReceipt",
      "receipt",
    ]);
    if (record === undefined) return false;
    const receipt = record.get("receipt");
    const input = parseReviewInput(
      Object.freeze({
        assessment: record.get("assessment"),
        assuranceReceipt: record.get("assuranceReceipt"),
        lintReceipt: record.get("lintReceipt"),
      }),
    );
    const state = authorities.get(authority);
    const binding =
      typeof receipt === "object" && receipt !== null
        ? receipts.get(receipt)
        : undefined;
    if (
      state === undefined ||
      input === undefined ||
      binding?.owner !== authority ||
      binding.inputDigest !== reviewInputDigest(input) ||
      !bindingsValid(state, input)
    )
      return false;
    const reviewReceipt = receipt as SecurityReviewReceipt;
    const { receiptDigest: _receiptDigest, ...material } = reviewReceipt;
    return (
      reviewReceipt.status === "accepted" &&
      reviewReceipt.blockingFindingFingerprints.length === 0 &&
      reviewReceipt.receiptDigest === digestValue(material)
    );
  } catch {
    return false;
  }
}

function bindingsValid(
  state: ReviewState,
  input: SecurityReviewInput,
): boolean {
  if (
    input.lintReceipt.assuranceReceiptDigest !==
      input.assuranceReceipt.receiptDigest ||
    input.lintReceipt.candidateDigest !==
      input.assuranceReceipt.candidateDigest ||
    input.lintReceipt.candidateManifestDigest !==
      input.assuranceReceipt.candidateManifestDigest ||
    input.lintReceipt.policyDigest !== state.linter.policyDigest ||
    !state.linter.verify(
      Object.freeze({
        assessment: input.assessment,
        assuranceReceipt: input.assuranceReceipt,
        receipt: input.lintReceipt,
      }),
    )
  )
    return false;
  try {
    if (
      !state.assurance.verify(
        Object.freeze({
          receipt: input.assuranceReceipt,
          assessment: input.assessment,
        }),
      )
    )
      return false;
  } catch {
    return false;
  }
  return true;
}

function parseReviewInput(value: unknown): SecurityReviewInput | undefined {
  const record = exactFrozenRecord(value, [
    "assessment",
    "assuranceReceipt",
    "lintReceipt",
  ]);
  const assessment = record?.get("assessment");
  const assuranceReceipt = record?.get("assuranceReceipt");
  const lintReceipt = record?.get("lintReceipt");
  if (
    record === undefined ||
    typeof assessment !== "object" ||
    assessment === null ||
    typeof assuranceReceipt !== "object" ||
    assuranceReceipt === null ||
    typeof lintReceipt !== "object" ||
    lintReceipt === null
  )
    return;
  return Object.freeze({
    assessment: assessment as ChangeAssuranceAssessmentInput,
    assuranceReceipt: assuranceReceipt as ChangeAssuranceReceipt,
    lintReceipt: lintReceipt as SecurityPolicyLintReceipt,
  });
}

function reviewInputDigest(
  input: SecurityReviewInput,
): ReturnType<typeof digestValue> {
  return digestValue({
    assessmentDigest: assessmentDigest(input.assessment),
    assuranceReceiptDigest: input.assuranceReceipt.receiptDigest,
    lintReceiptDigest: input.lintReceipt.receiptDigest,
  });
}
