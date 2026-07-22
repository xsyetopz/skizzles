export type JsonSemanticValueKind =
  | "array"
  | "boolean"
  | "missing"
  | "null"
  | "number"
  | "object"
  | "string";

export type JsonSemanticDifferenceCode =
  | "KIND_MISMATCH"
  | "MISSING_MEMBER"
  | "UNEXPECTED_MEMBER"
  | "VALUE_MISMATCH";

export type JsonSemanticRejectionCode =
  | "CYCLIC_VALUE"
  | "LIMIT_EXCEEDED"
  | "UNSAFE_OBJECT"
  | "UNSUPPORTED_VALUE";

export interface JsonSemanticDifference {
  readonly code: JsonSemanticDifferenceCode;
  readonly path: readonly (number | string)[];
  readonly actualKind: JsonSemanticValueKind;
  readonly expectedKind: JsonSemanticValueKind;
}

export type JsonSemanticComparisonResult =
  | Readonly<{
      status: "equal";
      domain: "json-value";
    }>
  | Readonly<{
      status: "different";
      domain: "json-value";
      difference: JsonSemanticDifference;
    }>
  | Readonly<{
      status: "rejected";
      domain: "json-value";
      side: "actual" | "expected";
      code: JsonSemanticRejectionCode;
      path: readonly (number | string)[];
    }>;
