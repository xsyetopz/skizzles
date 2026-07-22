import type { Digest } from "../digest.ts";
import type { TypeScriptAstChange } from "../typescript/contract.ts";

export interface StructuralPolicyReceipt {
  readonly metricVersion: "cyclomatic-v1";
  readonly maxFunctionComplexity: number;
  readonly maxFunctionIncrease: number;
  readonly maxAggregateIncrease: number;
  readonly policyDigest: Digest;
}

export interface ExecutableSpan {
  readonly start: number;
  readonly end: number;
}

export interface MutationSiteEvidence {
  readonly siteId: Digest;
  readonly kind: "operator" | "condition" | "boundary" | "return";
  readonly operator: string;
  readonly span: ExecutableSpan;
  readonly variants: readonly MutationVariantEvidence[];
  readonly branchId?: Digest;
}

export interface MutationVariantEvidence {
  readonly variantId: Digest;
  readonly replacement: string;
}

export interface ExecutableVersionEvidence {
  readonly nodeDigest: Digest;
  readonly span: ExecutableSpan;
  readonly lineIds: readonly Digest[];
  readonly complexity: number;
  readonly branchIds: readonly Digest[];
  readonly mutationSites: readonly MutationSiteEvidence[];
  readonly versionDigest: Digest;
}

export interface ModifiedExecutableNodeEvidence {
  readonly nodeId: Digest;
  readonly path: string;
  readonly pathDigest: Digest;
  readonly functionKey: string;
  readonly kind:
    | "arrow-function"
    | "class-initializer"
    | "constructor"
    | "function"
    | "function-expression"
    | "get-accessor"
    | "method"
    | "module-initializer"
    | "set-accessor";
  readonly nodeDigest: Digest;
  readonly span: ExecutableSpan;
  readonly lineIds: readonly Digest[];
  readonly branchIds: readonly Digest[];
  readonly mutationSites: readonly MutationSiteEvidence[];
  readonly baseline: ExecutableVersionEvidence | null;
  readonly candidate: ExecutableVersionEvidence | null;
  readonly baselineComplexity: number;
  readonly candidateComplexity: number;
  readonly increase: number;
  readonly complexityReceiptDigest: Digest;
}

export interface StructuralAstChangeEvidence {
  readonly epoch: number;
  readonly change: TypeScriptAstChange;
}

export interface CompilerChainLink {
  readonly epoch: number;
  readonly kind: "edit" | "format";
  readonly predecessorReceiptDigest: Digest | null;
  readonly predecessorCandidateSetDigest: Digest;
  readonly candidateSetDigest: Digest;
  readonly targetSetDigest: Digest;
  readonly compilerReceiptDigest: Digest;
  readonly linkDigest: Digest;
}

export interface CompilerChainReceipt {
  readonly targetSetDigest: Digest;
  readonly baselineCandidateSetDigest: Digest;
  readonly finalCandidateSetDigest: Digest;
  readonly links: readonly CompilerChainLink[];
  readonly receiptDigest: Digest;
}

export interface StructuralEvidenceReceipt {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: Digest;
  readonly configDigest: Digest;
  readonly targetSetDigest: Digest;
  readonly baselineCandidateSetDigest: Digest;
  readonly candidateSetDigest: Digest;
  readonly policy: StructuralPolicyReceipt;
  readonly astChanges: readonly StructuralAstChangeEvidence[];
  readonly modifiedNodes: readonly ModifiedExecutableNodeEvidence[];
  readonly baselineAggregateComplexity: number;
  readonly candidateAggregateComplexity: number;
  readonly aggregateIncrease: number;
  readonly compilerChain: CompilerChainReceipt;
  readonly receiptDigest: Digest;
}
