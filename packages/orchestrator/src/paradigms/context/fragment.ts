import { digestValue } from "../../digest.ts";
import type { ContextFragment, ContextKind } from "./contract.ts";
import { snapshotRecord } from "./guard.ts";

const fragments = new WeakSet<object>();
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;
const maximumContentLength = 1_048_576;

export type FragmentCreationResult =
  | Readonly<{ status: "created"; fragment: ContextFragment }>
  | Readonly<{ status: "rejected"; code: "INVALID_CONTEXT_FRAGMENT" }>;

export function createContextFragment(input: unknown): FragmentCreationResult {
  const value = snapshotRecord(input, [
    "id",
    "kind",
    "critical",
    "priority",
    "content",
  ]);
  if (
    value === undefined ||
    typeof value["id"] !== "string" ||
    !idPattern.test(value["id"]) ||
    !isContextKind(value["kind"]) ||
    typeof value["critical"] !== "boolean" ||
    (value["critical"] && value["kind"] === "supporting") ||
    typeof value["priority"] !== "number" ||
    !Number.isSafeInteger(value["priority"]) ||
    value["priority"] < 0 ||
    value["priority"] > 100 ||
    typeof value["content"] !== "string" ||
    value["content"].length < 1 ||
    value["content"].length > maximumContentLength
  ) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_CONTEXT_FRAGMENT",
    });
  }
  const fragment: ContextFragment = Object.freeze({
    id: value["id"],
    kind: value["kind"],
    critical: value["critical"],
    priority: value["priority"],
    content: value["content"],
    digest: digestValue(
      Object.freeze({
        id: value["id"],
        kind: value["kind"],
        critical: value["critical"],
        priority: value["priority"],
        content: value["content"],
      }),
    ),
  });
  fragments.add(fragment);
  return Object.freeze({ status: "created", fragment });
}

export function isContextFragment(input: unknown): input is ContextFragment {
  return (
    typeof input === "object" &&
    input !== null &&
    fragments.has(input) &&
    Object.isFrozen(input)
  );
}

function isContextKind(input: unknown): input is ContextKind {
  return (
    input === "ast" ||
    input === "contract" ||
    input === "spec" ||
    input === "supporting"
  );
}
