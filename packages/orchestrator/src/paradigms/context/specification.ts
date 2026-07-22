import type {
  ContextFragment,
  SpecificationContextAuthority,
  SpecificationContextAuthorityCreationResult,
} from "./contract.ts";
import { createContextFragment } from "./fragment.ts";
import {
  isFrozenDataObject,
  snapshotFrozenArray,
  snapshotRecord,
} from "./guard.ts";

const authorities = new WeakSet<object>();
const maximumSpecifications = 64;

export function createSpecificationContextAuthority(
  input: unknown,
): SpecificationContextAuthorityCreationResult {
  if (!isFrozenDataObject(input)) return rejected();
  const value = snapshotRecord(input, ["specifications"]);
  const specifications = snapshotFrozenArray(
    value?.["specifications"],
    maximumSpecifications,
  );
  if (specifications === undefined) return rejected();
  const fragments: ContextFragment[] = [];
  const ids = new Set<string>();
  for (const raw of specifications) {
    if (!isFrozenDataObject(raw)) return rejected();
    const specification = snapshotRecord(raw, ["id", "content"]);
    if (
      specification === undefined ||
      typeof specification["id"] !== "string" ||
      ids.has(specification["id"])
    ) {
      return rejected();
    }
    const created = createContextFragment({
      id: `spec.${specification["id"]}`,
      kind: "spec",
      critical: true,
      priority: 100,
      content: specification["content"],
    });
    if (created.status !== "created") return rejected();
    ids.add(specification["id"]);
    fragments.push(created.fragment);
  }
  const immutableFragments = Object.freeze(fragments);
  const authority: SpecificationContextAuthority = Object.freeze({
    schema: "skizzles.orchestrator/specification-context-authority/v1" as const,
    fragments: () => immutableFragments,
  });
  authorities.add(authority);
  return Object.freeze({ status: "created" as const, authority });
}

export function isSpecificationContextAuthority(
  value: unknown,
): value is SpecificationContextAuthority {
  return typeof value === "object" && value !== null && authorities.has(value);
}

function rejected(): SpecificationContextAuthorityCreationResult {
  return Object.freeze({
    status: "rejected" as const,
    code: "INVALID_SPECIFICATION_CONTEXT" as const,
  });
}
