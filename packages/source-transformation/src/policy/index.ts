import { inspectAssertions } from "./assertion/rule.ts";
import { inspectCatches } from "./catches.ts";
import { createRuleContext } from "./context.ts";
import type { PolicyAnalysisInput, PolicyFinding } from "./contract.ts";
import { comparePolicyFindings } from "./contract.ts";
import { inspectFaultFirst } from "./fault-first.ts";
import { isLiteralRegistrySnapshot } from "./literal/registry.ts";
import { inspectPolicyLiterals } from "./literals.ts";
import { inspectPlaceholders } from "./placeholders.ts";
import { inspectTypeSafety } from "./safety.ts";

export type {
  FaultFirstDeclaration,
  FaultFirstInspection,
  NegativePathEvidence,
  ObservedNegativePathEvidence,
  ParsedPolicyChange,
  PolicyAnalysisInput,
  PolicyFinding,
  PolicyFindingCode,
} from "./contract.ts";
export type {
  LiteralRegistrationReceipt,
  LiteralRegistrationResult,
  LiteralRegistry,
  LiteralRegistryCreationResult,
  LiteralRegistrySnapshot,
  LiteralSyntaxExemption,
  RegisteredLiteralEntry,
  RegisteredLiteralValue,
} from "./literal/contract.ts";
export {
  createLiteralRegistry,
  isLiteralRegistrationReceipt,
  isLiteralRegistry,
  isLiteralRegistrySnapshot,
} from "./literal/registry.ts";

export function analyzeSourcePolicy(input: unknown): readonly PolicyFinding[] {
  try {
    if (!isPolicyInput(input)) {
      return invalidInput(
        "Policy analysis input did not match the closed contract.",
      );
    }
    const faultFirst = inspectFaultFirst(input);
    const findings = [...faultFirst.findings];
    for (const change of input.changes) {
      const context = createRuleContext(change);
      inspectAssertions(context);
      inspectCatches(context);
      inspectPlaceholders(context);
      inspectTypeSafety(context);
      inspectPolicyLiterals(context, input.literalRegistry);
      findings.push(...context.findings);
    }
    const sorted = [...findings]
      .sort(comparePolicyFindings)
      .map((finding) => Object.freeze(finding));
    return Object.freeze(sorted);
  } catch {
    return invalidInput(
      "Policy analysis failed closed while inspecting parsed source.",
    );
  }
}

export { inspectFaultFirst } from "./fault-first.ts";

function isPolicyInput(value: unknown): value is PolicyAnalysisInput {
  if (
    !(
      isRecord(value) &&
      Array.isArray(value["changes"]) &&
      isLiteralRegistrySnapshot(value["literalRegistry"]) &&
      isRecord(value["faultFirst"])
    )
  ) {
    return false;
  }
  if (
    !(
      Array.isArray(value["faultFirst"]["declarations"]) &&
      Array.isArray(value["faultFirst"]["negativeTests"])
    )
  ) {
    return false;
  }
  return value["changes"].every(
    (change) =>
      isRecord(change) &&
      typeof change["path"] === "string" &&
      change["path"].length > 0 &&
      (change["ownership"] === "production" ||
        change["ownership"] === "test") &&
      (change["baselineText"] === null ||
        typeof change["baselineText"] === "string") &&
      typeof change["candidateText"] === "string" &&
      (change["baseline"] === null || isSourceFileLike(change["baseline"])) &&
      isSourceFileLike(change["candidate"]),
  );
}

function isSourceFileLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["kind"] === "number" &&
    typeof value["getText"] === "function" &&
    typeof value["forEachChild"] === "function" &&
    Array.isArray(value["statements"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidInput(message: string): readonly PolicyFinding[] {
  return Object.freeze([
    Object.freeze({
      path: "<policy-input>",
      start: 0,
      end: 0,
      code: "INVALID_POLICY_INPUT" as const,
      message,
    }),
  ]);
}
