import type {
  SecurityAnalysisReceipt,
  SecurityFinding,
  SecurityTargetReceipt,
} from "../../contract.ts";
import { digestBytes, digestValue } from "../../digest.ts";

export function targetReceipt(
  path: string,
  bytes: Uint8Array | undefined,
  findings: readonly SecurityFinding[],
): SecurityTargetReceipt {
  const candidateDigest =
    bytes === undefined ? digestBytes(new Uint8Array()) : digestBytes(bytes);
  return Object.freeze({
    path,
    candidateDigest,
    findings: Object.freeze([...findings]),
  });
}

export function finding(
  code: SecurityFinding["code"],
  path: string,
  message: string,
  line = 1,
  column = 1,
  trace: readonly Readonly<{
    readonly path: string;
    readonly line: number;
    readonly column: number;
    readonly kind: string;
  }>[] = Object.freeze([{ path, line, column, kind: "finding" }]),
): SecurityFinding {
  const severity = criticalCodes.has(code) ? "critical" : "high";
  const confidence = uncertainCodes.has(code) ? "medium" : "high";
  const traceDigest = digestValue({ version: "security-trace-v1", trace });
  const fingerprint = digestValue({
    version: "security-finding-v1",
    code,
    severity,
    path,
    line,
    column,
    traceDigest,
  });
  return Object.freeze({
    code,
    severity,
    confidence,
    fingerprint,
    traceDigest,
    path,
    message,
    line,
    column,
  });
}

const criticalCodes = new Set<SecurityFinding["code"]>([
  "CANDIDATE_DIGEST_MISMATCH",
  "INVALID_CANDIDATE",
  "INVALID_CONFIG",
  "SYNTAX_ERROR",
  "CUSTOM_CRYPTOGRAPHY",
  "RAW_EXECUTION_PRIMITIVE",
  "TAINTED_EXECUTION_FLOW",
  "DYNAMIC_SECURITY_DISPATCH",
  "SESSION_BOUNDARY_FORGED",
]);

const uncertainCodes = new Set<SecurityFinding["code"]>([
  "UNKNOWN_SECURITY_FLOW",
  "UNRESOLVED_SECURITY_SYMBOL",
]);

export function sortFindings(
  findings: readonly SecurityFinding[],
): SecurityFinding[] {
  return [...findings].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );
}

export function invalidConfigReceipt(): SecurityAnalysisReceipt {
  const findings = [
    finding("INVALID_CONFIG", "<config>", "Security policy schema is invalid."),
  ];
  return Object.freeze({
    status: "rejected",
    findingCount: 1,
    findings: Object.freeze(findings),
    targetReceipts: Object.freeze([]),
    evidenceDigest: digestValue({ code: "INVALID_CONFIG" }),
  });
}
