import type { AssuranceDigest } from "../digest.ts";

export type MigrationPhase = "schema" | "backfill" | "rollback";

export interface MigrationSource {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly phase: MigrationPhase;
  readonly order: number;
  readonly identity?: string;
}

export type SqlTokenKind =
  | "keyword"
  | "identifier"
  | "number"
  | "string"
  | "quoted-identifier"
  | "punctuation";

export interface SqlToken {
  readonly kind: SqlTokenKind;
  readonly value: string;
  readonly offset: number;
}

export type MigrationOperationKind =
  | "create-table"
  | "create-index"
  | "create-sequence"
  | "create-type"
  | "update"
  | "insert-select"
  | "drop-table"
  | "drop-index"
  | "drop-type";

export interface MigrationOperation {
  readonly identity: string;
  readonly kind: MigrationOperationKind;
  readonly phase: MigrationPhase;
  readonly path: string;
  readonly statementIndex: number;
  readonly digest: AssuranceDigest;
}

export type MigrationFindingCode =
  | "INVALID_PATH"
  | "INVALID_ORDER"
  | "MISSING_PHASE"
  | "DUPLICATE_IDENTITY"
  | "EMPTY_MIGRATION"
  | "TOKENIZATION_ERROR"
  | "UNKNOWN_STATEMENT"
  | "ALTER_STATEMENT"
  | "LOCK_STATEMENT"
  | "DESTRUCTIVE_STATEMENT"
  | "UNSAFE_BACKFILL"
  | "ROLLBACK_CASCADE"
  | "IDENTITY_MISMATCH"
  | "UNEXPECTED_PHASE_OPERATION";

export interface MigrationFinding {
  readonly code: MigrationFindingCode;
  readonly path: string;
  readonly message: string;
  readonly statementIndex?: number;
}

export interface MigrationLintReceipt {
  readonly accepted: boolean;
  readonly candidateDigest: AssuranceDigest;
  readonly operations: readonly MigrationOperation[];
  readonly findings: readonly MigrationFinding[];
  readonly phaseOrder: readonly MigrationPhase[];
  readonly receiptDigest: AssuranceDigest;
}

export type MigrationLintResult =
  | { readonly ok: true; readonly receipt: MigrationLintReceipt }
  | { readonly ok: false; readonly receipt: MigrationLintReceipt };

export interface MigrationLinter {
  readonly lint: (sources: readonly MigrationSource[]) => MigrationLintResult;
}

export type SqlTokenizationResult =
  | { readonly ok: true; readonly tokens: readonly SqlToken[] }
  | {
      readonly ok: false;
      readonly code: "TOKENIZATION_ERROR";
      readonly message: string;
      readonly offset: number;
    };

export interface ParsedStatement {
  readonly tokens: readonly SqlToken[];
  readonly statementIndex: number;
}
