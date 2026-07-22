import type { Digest } from "../../digest.ts";

export type ProtectedContextKind = "ast" | "contract" | "spec";
export type ContextKind = ProtectedContextKind | "supporting";

export interface ContextFragment {
  readonly id: string;
  readonly kind: ContextKind;
  readonly critical: boolean;
  readonly priority: number;
  readonly content: string;
  readonly digest: Digest;
}

export interface ContextPlacement {
  readonly fragmentId: string;
  readonly fragmentDigest: Digest;
  readonly originalIndex: number;
  readonly rank: number | null;
  readonly region: "beginning" | "middle" | "end";
  readonly occurrence: number;
}

export interface PrioritizationReceipt {
  readonly algorithm: "lost-in-the-middle-bookends-v1";
  readonly inputDigest: Digest;
  readonly outputDigest: Digest;
  readonly placements: readonly ContextPlacement[];
  readonly receiptDigest: Digest;
}

export interface CompressionDecision {
  readonly fragmentId: string;
  readonly occurrence: number;
  readonly action: "omitted" | "preserved" | "whitespace-collapsed";
  readonly reason:
    | "protected-fragment"
    | "within-token-target"
    | "whitespace-reduction"
    | "token-target";
  readonly beforeTokenEstimate: number;
  readonly afterTokenEstimate: number;
  readonly beforeDigest: Digest;
  readonly afterDigest: Digest | null;
}

export interface CompressionReceipt {
  readonly algorithm: "auditable-context-compression-v1";
  readonly estimator: "utf8-bytes-ceiling-divided-by-four-v1";
  readonly targetTokenEstimate: number;
  readonly beforeTokenEstimate: number;
  readonly afterTokenEstimate: number;
  readonly inputDigest: Digest;
  readonly outputDigest: Digest;
  readonly decisions: readonly CompressionDecision[];
  readonly decisionsDigest: Digest;
  readonly receiptDigest: Digest;
}

export interface OutboundContextPayload {
  readonly sections: readonly string[];
  readonly beforeTokenEstimate: number;
  readonly afterTokenEstimate: number;
  readonly prioritization: PrioritizationReceipt;
  readonly compression: CompressionReceipt | null;
  readonly payloadDigest: Digest;
}

export type ContextBuildResult =
  | Readonly<{ status: "built"; payload: OutboundContextPayload }>
  | Readonly<{
      status: "rejected";
      code:
        | "INVALID_CONTEXT_INPUT"
        | "MISSING_PROTECTED_FRAGMENT"
        | "TOKEN_TARGET_UNSATISFIABLE";
    }>;

export interface OutboundContextMiddleware {
  readonly build: (input: unknown) => ContextBuildResult;
  readonly verify: (input: unknown) => boolean;
}

export interface SpecificationContextAuthority {
  readonly schema: "skizzles.orchestrator/specification-context-authority/v1";
  readonly fragments: () => readonly ContextFragment[];
}

export type SpecificationContextAuthorityCreationResult =
  | Readonly<{
      status: "created";
      authority: SpecificationContextAuthority;
    }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_SPECIFICATION_CONTEXT";
    }>;
