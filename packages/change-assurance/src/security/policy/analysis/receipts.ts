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
): SecurityFinding {
  return Object.freeze({ code, path, message, line, column });
}

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
