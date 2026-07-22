import type {
  SecurityAnalysisReceipt,
  SecurityAssessment,
  SecurityFinding,
  SecurityPolicyConfig,
  SecurityTargetReceipt,
} from "../contract.ts";
import { bytesFromCandidate, digestValue } from "../digest.ts";
import { inspectEntrypoint } from "./analysis/entrypoints.ts";
import {
  finding,
  invalidConfigReceipt,
  sortFindings,
  targetReceipt,
} from "./analysis/receipts.ts";
import {
  inspectDeclarations,
  inspectImports,
  inspectSinks,
} from "./analysis/sinks.ts";
import { parseSecurityPolicyConfig } from "./config.ts";
import { parseSecurityCandidate } from "./parser.ts";

export async function analyzeSecurityCandidates(
  assessment: SecurityAssessment,
  configInput: SecurityPolicyConfig | unknown,
): Promise<SecurityAnalysisReceipt> {
  const config = parseSecurityPolicyConfig(configInput);
  if (config === undefined) return invalidConfigReceipt();
  const targetReceipts: SecurityTargetReceipt[] = [];
  for (const target of assessment.targets) {
    targetReceipts.push(await analyzeTarget(target, config));
  }
  const findings = targetReceipts.flatMap(
    ({ findings: targetFindings }) => targetFindings,
  );
  const orderedFindings = sortFindings(findings);
  const evidenceDigest = digestValue({
    version: "security-ast-v1",
    requestDigest: assessment.requestDigest,
    declarationDigest: assessment.declarationDigest,
    targets: targetReceipts,
  });
  return Object.freeze({
    status: orderedFindings.length === 0 ? "accepted" : "rejected",
    findingCount: orderedFindings.length,
    findings: Object.freeze(orderedFindings),
    targetReceipts: Object.freeze(targetReceipts),
    evidenceDigest,
  });
}

async function analyzeTarget(
  target: SecurityAssessment["targets"][number],
  config: SecurityPolicyConfig,
): Promise<SecurityTargetReceipt> {
  const candidateBytes = bytesFromCandidate(target.candidateBytes);
  const findings: SecurityFinding[] = [];
  if (candidateBytes === undefined) {
    findings.push(
      finding(
        "INVALID_CANDIDATE",
        target.path,
        "Candidate bytes are required for AST security analysis.",
      ),
    );
    return targetReceipt(target.path, candidateBytes, findings);
  }
  const parsed = await parseSecurityCandidate(target.path, candidateBytes);
  if (parsed.status === "rejected") {
    const code =
      parsed.code === "SYNTAX_ERROR" ? "SYNTAX_ERROR" : "INVALID_CANDIDATE";
    findings.push(
      finding(
        code,
        target.path,
        parsed.diagnostics.join("; ") ||
          "Candidate could not be parsed as a TypeScript AST.",
      ),
    );
    return targetReceipt(target.path, candidateBytes, findings);
  }
  inspectEntrypoint(parsed.source, target.path, config, findings);
  inspectImports(parsed.source, target.path, config, findings);
  inspectDeclarations(parsed.source, target.path, findings);
  inspectSinks(parsed.source, target.path, config, findings);
  return targetReceipt(target.path, candidateBytes, findings);
}
