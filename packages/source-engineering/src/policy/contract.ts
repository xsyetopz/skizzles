import type { SourceFile } from "typescript/unstable/ast";
import type { LiteralRegistrySnapshot } from "./literal/contract.ts";

export type PolicyFindingCode =
  | "BRITTLE_STRUCTURE_ASSERTION"
  | "EMPTY_CATCH"
  | "EMPTY_NAMED_BODY"
  | "EXPLICIT_ANY"
  | "FAULT_FIRST_DECLARATION_MISSING"
  | "INVALID_POLICY_INPUT"
  | "NEGATIVE_PATH_EVIDENCE_MISSING"
  | "PLACEHOLDER_COMMENT"
  | "STUB_THROW"
  | "UNREGISTERED_LITERAL"
  | "UNSCHEMATIZED_DYNAMIC_BOUNDARY"
  | "UNSAFE_NON_NULL_ASSERTION"
  | "UNSAFE_TYPE_ASSERTION"
  | "UNUSED_CATCH_BINDING";

export interface PolicyFinding {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly code: PolicyFindingCode;
  readonly message: string;
}

export interface ParsedPolicyChange {
  readonly path: string;
  readonly ownership: "production" | "test";
  readonly baselineText: string | null;
  readonly baseline: SourceFile | null;
  readonly candidateText: string;
  readonly candidate: SourceFile;
}

export interface FaultFirstDeclaration {
  readonly productionPath: string;
  readonly failureCodes: readonly string[];
}

export interface NegativePathEvidence {
  readonly productionPath: string;
  readonly testPath: string;
}

export interface ObservedNegativePathEvidence {
  readonly productionPath: string;
  readonly testPath: string;
  readonly failureCodes: readonly string[];
}

export interface FaultFirstInspection {
  readonly findings: readonly PolicyFinding[];
  readonly observedEvidence: readonly ObservedNegativePathEvidence[];
  readonly evidenceDigest: `sha256:${string}`;
}

export interface PolicyAnalysisInput {
  readonly changes: readonly ParsedPolicyChange[];
  readonly literalRegistry: LiteralRegistrySnapshot;
  readonly faultFirst: {
    readonly declarations: readonly FaultFirstDeclaration[];
    readonly negativeTests: readonly NegativePathEvidence[];
  };
}

export interface ChangedNodeContext {
  readonly change: ParsedPolicyChange;
  readonly changedNodes: ReadonlySet<object>;
}

export function comparePolicyFindings(
  left: PolicyFinding,
  right: PolicyFinding,
): number {
  return (
    compareText(left.path, right.path) ||
    left.start - right.start ||
    left.end - right.end ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message)
  );
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
