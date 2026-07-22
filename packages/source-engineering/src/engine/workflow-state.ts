import type { Digest } from "../digest.ts";
import type {
  SourceCaptureReceipt,
  SourceEvidenceAuthority,
  TemplateEvidenceReceipt,
} from "../evidence/source.ts";
import type {
  SourceLanguageAdapterBindings,
  TypeScriptAstDocument,
  TypeScriptAstSymbolIndex,
} from "../language/typescript-contract.ts";
import type { LiteralRegistry } from "../policy/literal/contract.ts";
import type {
  SourceEngineeringArtifact,
  SourceEngineeringContext,
  SourceEngineeringContextReceipt,
  SourceEngineeringCursor,
  SourceEngineeringTaskReceipt,
} from "./contract.ts";

export interface EngineTemplate {
  readonly templateId: string;
  readonly language: string;
  readonly schemaText: string;
  readonly schemaDigest: Digest;
  readonly description: string;
  readonly bindings: readonly string[];
  readonly tool: string;
  readonly version: string;
}

export interface EngineConfig {
  readonly sourceEvidence: SourceEvidenceAuthority;
  readonly languageAdapters: ReadonlyMap<string, SourceLanguageAdapterBindings>;
  readonly literalRegistry: LiteralRegistry;
  readonly templates: ReadonlyMap<string, EngineTemplate>;
}

export interface RepositoryBinding {
  readonly id: string;
  readonly rootIdentity: string;
  readonly treeDigest: Digest;
  readonly configDigest: Digest;
}

export interface DescribeRequest {
  readonly requestDigest: Digest;
  readonly repository: RepositoryBinding;
  readonly language: string;
  readonly objective: "behavioral" | "format-only";
  readonly targets: readonly { readonly path: string }[];
  readonly formatterId: string;
}

export interface EngineSelector {
  readonly declarationKind: string;
  readonly name: string;
  readonly expectedNodeDigest: Digest;
}

export type EngineOperation =
  | Readonly<{
      kind: "replace";
      selector: EngineSelector;
      templateId: string;
      nodeSource: string;
    }>
  | Readonly<{
      kind: "insert";
      anchor: EngineSelector;
      position: "before" | "after";
      templateId: string;
      nodeSource: string;
    }>
  | Readonly<{ kind: "delete"; selector: EngineSelector }>;

export interface BatchTarget {
  readonly path: string;
  readonly operations: readonly EngineOperation[];
}

export interface BatchRequest extends DescribeRequest {
  readonly context: object;
  readonly contextDigest: Digest;
  readonly targets: readonly BatchTarget[];
  readonly faultCases: Readonly<{
    declarations: readonly Readonly<{
      productionPath: string;
      failureCodes: readonly string[];
    }>[];
    negativeTests: readonly Readonly<{
      productionPath: string;
      testPath: string;
    }>[];
  }>;
}

export interface ContextTargetState {
  readonly path: string;
  readonly capture: SourceCaptureReceipt;
  readonly baselineBytes: readonly number[];
  readonly baseline: TypeScriptAstDocument;
}

export interface ContextState {
  readonly request: DescribeRequest;
  readonly adapter: SourceLanguageAdapterBindings;
  readonly context: SourceEngineeringContext;
  readonly receipt: SourceEngineeringContextReceipt;
  readonly targets: readonly ContextTargetState[];
  readonly index: TypeScriptAstSymbolIndex;
  consumed: boolean;
}

export interface BatchTargetState {
  readonly path: string;
  readonly capture: SourceCaptureReceipt;
  readonly baselineBytes: readonly number[];
  readonly baseline: TypeScriptAstDocument;
  readonly operations: readonly EngineOperation[];
  candidate: TypeScriptAstDocument;
  changedDeclarations: Digest[];
  templateReceipts: TemplateEvidenceReceipt[];
  formatterReceipt:
    | import("../evidence/contract.ts").FormatterProvenanceReceipt
    | null;
}

export interface BatchStep {
  readonly kind: "edit" | "format" | "validate";
  readonly ordinal: number;
  readonly operationIndex?: number;
}

export interface BatchState {
  readonly request: BatchRequest;
  readonly targets: BatchTargetState[];
  readonly steps: readonly BatchStep[];
  readonly context: ContextState;
  step: number;
}

export interface CursorState {
  readonly cursor: SourceEngineeringCursor;
  readonly batch: BatchState;
  consumed: boolean;
}

export interface PreparedState {
  readonly artifacts: readonly SourceEngineeringArtifact[];
  readonly receipt: SourceEngineeringTaskReceipt;
  readonly bytesByPath: ReadonlyMap<string, readonly number[]>;
  consumed: boolean;
}
