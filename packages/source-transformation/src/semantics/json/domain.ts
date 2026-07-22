import type { JsonSemanticRejectionCode } from "../contract.ts";

export type SemanticNode =
  | Readonly<{ kind: "null" }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "number"; value: number }>
  | Readonly<{ kind: "string"; value: string }>
  | Readonly<{ kind: "array"; values: readonly SemanticNode[] }>
  | Readonly<{
      kind: "object";
      values: ReadonlyMap<string, SemanticNode>;
    }>;

export type SnapshotResult =
  | Readonly<{ status: "captured"; node: SemanticNode }>
  | Readonly<{
      status: "rejected";
      code: JsonSemanticRejectionCode;
      path: readonly (number | string)[];
    }>;

export function appendSemanticPath(
  path: readonly (number | string)[],
  part: number | string,
): readonly (number | string)[] {
  return [...path, part];
}

export function compareSemanticNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
