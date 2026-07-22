// biome-ignore lint/correctness/noUnresolvedImports: TypeScript 7 exposes its parsed source contract through this unstable package export.
import type { Node, SourceFile } from "typescript/unstable/ast";
import type { Digest } from "../digest.ts";

export type DeclarationKind =
  | "class"
  | "enum"
  | "function"
  | "interface"
  | "type";

export interface DeclarationSelector {
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly expectedNodeDigest: Digest;
}

export type TypeScriptNodeOperation =
  | Readonly<{
      kind: "replace" | "insert-before" | "insert-after";
      selector: DeclarationSelector;
      source: string;
    }>
  | Readonly<{
      kind: "delete";
      selector: DeclarationSelector;
    }>;

export interface ParsedTypeScriptSource {
  readonly path: string;
  readonly text: string;
  readonly sourceFile: SourceFile;
}

export interface TypeScriptDeclaration {
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly nodeDigest: Digest;
}

export interface TypeScriptAstNodeIdentity {
  readonly nodeId: Digest;
  readonly declarationKind: DeclarationKind;
  readonly name: string;
  readonly nodeDigest: Digest;
  readonly identityDigest: Digest;
  readonly span: Readonly<{ start: number; end: number }>;
}

export interface TypeScriptAstChange {
  readonly path: string;
  readonly operation: TypeScriptNodeOperation["kind"];
  readonly anchor: TypeScriptAstNodeIdentity;
  readonly baselineNode: TypeScriptAstNodeIdentity | null;
  readonly candidateNode: TypeScriptAstNodeIdentity | null;
  readonly changeDigest: Digest;
}

export interface TypeScriptEditReceipt {
  readonly path: string;
  readonly objective: "behavioral" | "format-only";
  readonly baselineDigest: Digest;
  readonly baselineSemanticDigest: Digest;
  readonly candidateDigest: Digest;
  readonly candidateSemanticDigest: Digest;
  readonly candidateBytes: readonly number[];
  readonly changes: readonly TypeScriptAstChange[];
}

export type TypeScriptEditResult =
  | { readonly status: "edited"; readonly receipt: TypeScriptEditReceipt }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_EDIT"
        | "NODE_NOT_FOUND"
        | "NODE_AMBIGUOUS"
        | "NODE_DRIFTED"
        | "SEMANTIC_DRIFT"
        | "SEMANTIC_NOOP";
    };

export interface LocatedDeclaration extends TypeScriptDeclaration {
  readonly node: Node;
}
