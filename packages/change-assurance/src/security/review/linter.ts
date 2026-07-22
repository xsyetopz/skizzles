import type { ChangeAssuranceAssessmentInput } from "../../contract.ts";
import { digestValue } from "../../digest.ts";
import { isChangeAssurance } from "../../runtime.ts";
import type { SecurityPolicyConfig } from "../contract.ts";
import { analyzeSecurityCandidates } from "../policy/analyze.ts";
import { parseSecurityPolicyConfig } from "../policy/config.ts";
import type {
  SecurityPolicyLinterAuthority,
  SecurityPolicyLinterCreationResult,
  SecurityPolicyLintFinding,
  SecurityPolicyLintInput,
  SecurityPolicyLintReceipt,
  SecurityPolicyLintResult,
} from "./contract.ts";
import {
  assessmentDigest,
  assuranceBinds,
  authorityId,
  candidateDigestFor,
  exactFrozenRecord,
  parseLintInput,
} from "./input.ts";

interface LinterState {
  readonly assurance: import("../../contract.ts").ChangeAssurance;
  readonly policy: SecurityPolicyConfig;
  readonly policyDigest: ReturnType<typeof digestValue>;
}

interface ReceiptState {
  readonly owner: SecurityPolicyLinterAuthority;
  readonly inputDigest: ReturnType<typeof digestValue>;
}

const linters = new WeakMap<object, LinterState>();
const receipts = new WeakMap<object, ReceiptState>();

export function createSecurityPolicyLinter(
  input: unknown,
): SecurityPolicyLinterCreationResult {
  const record = exactFrozenRecord(input, [
    "authorityId",
    "assurance",
    "policy",
  ]);
  const parsedAuthorityId = authorityId(record?.get("authorityId"));
  const assurance = record?.get("assurance");
  const policy = parseSecurityPolicyConfig(record?.get("policy"));
  if (
    record === undefined ||
    parsedAuthorityId === undefined ||
    !isChangeAssurance(assurance) ||
    policy === undefined
  )
    return Object.freeze({ status: "rejected", code: "INVALID_LINTER_CONFIG" });
  const policyDigest = digestValue({ version: "security-policy-v2", policy });
  let authority: SecurityPolicyLinterAuthority;
  authority = Object.freeze({
    kind: "security-policy-linter",
    authorityId: parsedAuthorityId,
    policyDigest,
    lint: async (value: unknown) => await lint(authority, value),
    verify: (value: unknown) => verify(authority, value),
  });
  linters.set(authority, { assurance, policy, policyDigest });
  return Object.freeze({ status: "created", authority });
}

export function isSecurityPolicyLinter(
  value: unknown,
): value is SecurityPolicyLinterAuthority {
  return typeof value === "object" && value !== null && linters.has(value);
}

export function isSecurityPolicyLintReceipt(
  value: unknown,
): value is SecurityPolicyLintReceipt {
  return typeof value === "object" && value !== null && receipts.has(value);
}

export function linterOwnsReceipt(
  linter: SecurityPolicyLinterAuthority,
  receipt: unknown,
): receipt is SecurityPolicyLintReceipt {
  return receipts.get(receipt as object)?.owner === linter;
}

async function lint(
  authority: SecurityPolicyLinterAuthority,
  value: unknown,
): Promise<SecurityPolicyLintResult> {
  const state = linters.get(authority);
  const input = parseLintInput(value);
  if (state === undefined || input === undefined)
    return Object.freeze({ status: "halted", code: "INVALID_LINT_INPUT" });
  if (!assuranceBinds(state.assurance, input))
    return Object.freeze({
      status: "halted",
      code: "ASSURANCE_BINDING_REJECTED",
    });
  const securityReceipts = input.assuranceReceipt.extensionReceipts.filter(
    ({ domain }) => domain === "middleware-security",
  );
  const securityReceipt = securityReceipts[0];
  if (securityReceipts.length !== 1 || securityReceipt === undefined)
    return Object.freeze({
      status: "halted",
      code: "ASSURANCE_BINDING_REJECTED",
    });
  const analysisInput = securityAssessment(input.assessment);
  let analysis: Awaited<ReturnType<typeof analyzeSecurityCandidates>>;
  try {
    analysis = await analyzeSecurityCandidates(analysisInput, state.policy);
  } catch {
    return Object.freeze({
      status: "halted",
      code: "SECURITY_ANALYSIS_REJECTED",
    });
  }
  const findings: SecurityPolicyLintFinding[] = [];
  for (const finding of analysis.findings) {
    const candidateDigest = candidateDigestFor(input.assessment, finding.path);
    if (candidateDigest === undefined)
      return Object.freeze({
        status: "halted",
        code: "SECURITY_ANALYSIS_REJECTED",
      });
    findings.push(
      Object.freeze({
        ...finding,
        candidateDigest,
        fingerprint: digestValue({
          version: "security-policy-finding-v1",
          analyzerFingerprint: finding.fingerprint,
          candidateDigest,
        }),
      }),
    );
  }
  const material = Object.freeze({
    status: findings.length === 0 ? ("clear" as const) : ("findings" as const),
    authorityId: authority.authorityId,
    requestDigest: input.assessment.requestDigest,
    repositoryId: input.assessment.repositoryId,
    treeDigest: input.assessment.treeDigest,
    baselineDigest: input.assessment.baselineDigest,
    declarationDigest: input.assessment.declaration.declarationDigest,
    targetSetDigest: input.assuranceReceipt.targetSetDigest,
    candidateDigest: input.assuranceReceipt.candidateDigest,
    candidateManifestDigest: input.assuranceReceipt.candidateManifestDigest,
    assuranceReceiptDigest: input.assuranceReceipt.receiptDigest,
    securityEvidenceDigest: securityReceipt.evidenceDigest,
    policyDigest: state.policyDigest,
    findings: Object.freeze(findings),
  });
  const receipt: SecurityPolicyLintReceipt = Object.freeze({
    ...material,
    receiptDigest: digestValue(material),
  });
  receipts.set(receipt, {
    owner: authority,
    inputDigest: lintInputDigest(input),
  });
  return Object.freeze({ status: "completed", receipt });
}

function verify(
  authority: SecurityPolicyLinterAuthority,
  value: unknown,
): boolean {
  try {
    const record = exactFrozenRecord(value, [
      "assessment",
      "assuranceReceipt",
      "receipt",
    ]);
    const receipt = record?.get("receipt");
    const input = parseLintInput(
      record === undefined
        ? undefined
        : Object.freeze({
            assessment: record.get("assessment"),
            assuranceReceipt: record.get("assuranceReceipt"),
          }),
    );
    const state = linters.get(authority);
    const binding =
      typeof receipt === "object" && receipt !== null
        ? receipts.get(receipt)
        : undefined;
    if (
      state === undefined ||
      input === undefined ||
      binding?.owner !== authority ||
      binding.inputDigest !== lintInputDigest(input) ||
      !assuranceBinds(state.assurance, input)
    )
      return false;
    const lintReceipt = receipt as SecurityPolicyLintReceipt;
    const { receiptDigest: _receiptDigest, ...material } = lintReceipt;
    return (
      lintReceipt.policyDigest === state.policyDigest &&
      lintReceipt.receiptDigest === digestValue(material)
    );
  } catch {
    return false;
  }
}

function securityAssessment(
  input: ChangeAssuranceAssessmentInput,
): import("../contract.ts").SecurityAssessment {
  return Object.freeze({
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    treeDigest: input.treeDigest,
    baselineDigest: input.baselineDigest,
    declarationDigest: input.declaration.declarationDigest,
    domain: "middleware-security",
    plan: null,
    targets: input.targets,
  });
}

function lintInputDigest(
  input: SecurityPolicyLintInput,
): ReturnType<typeof digestValue> {
  return digestValue({
    assessmentDigest: assessmentDigest(input.assessment),
    assuranceReceiptDigest: input.assuranceReceipt.receiptDigest,
  });
}
