import {
  compareStrings,
  isReflexionDigest,
  normalizeIdentifier,
  normalizeRelativePath,
} from "./canonical.ts";
import type { ExternalSkillDirectoryReference } from "./contract.ts";
import { dataRecord, isProxy, strictFrozenArray } from "./object.ts";

const skillReferenceKeys = [
  "kind",
  "access",
  "directoryId",
  "relativeSkillPath",
  "revisionDigest",
] as const;
const maximumSkillReferenceCount = 64;

function parseSkillReferences(
  value: unknown,
  requireFrozen: boolean,
): readonly ExternalSkillDirectoryReference[] {
  if (isProxyArray(value) || (requireFrozen && !Object.isFrozen(value))) {
    throw new TypeError("skill references must be an immutable array");
  }
  let values: unknown = value;
  if (requireFrozen) {
    values = strictFrozenArray(value);
  }
  if (!Array.isArray(values) || values.length > maximumSkillReferenceCount) {
    throw new TypeError("skill reference count exceeds its limit");
  }
  const references = values.map((entry) =>
    parseSkillReference(entry, requireFrozen),
  );
  const canonical = [...references].sort((left, right) =>
    compareStrings(skillReferenceKey(left), skillReferenceKey(right)),
  );
  const keys = canonical.map(skillReferenceKey);
  if (
    new Set(keys).size !== keys.length ||
    (requireFrozen && hasOrderDrift(canonical, references))
  ) {
    throw new TypeError("skill references must be unique and canonical");
  }
  return Object.freeze(canonical);
}

function parseSkillReference(
  value: unknown,
  requireFrozen: boolean,
): ExternalSkillDirectoryReference {
  const record = dataRecord(value, skillReferenceKeys, requireFrozen);
  if (
    record === undefined ||
    record.kind !== "external-skill-directory" ||
    record.access !== "read-only" ||
    !isReflexionDigest(record.revisionDigest)
  ) {
    throw new TypeError("skill references must be structured and read-only");
  }
  return Object.freeze({
    kind: "external-skill-directory" as const,
    access: "read-only" as const,
    directoryId: normalizeIdentifier(record.directoryId, "directoryId"),
    relativeSkillPath: normalizeRelativePath(record.relativeSkillPath),
    revisionDigest: record.revisionDigest,
  });
}

function hasOrderDrift(
  canonical: readonly ExternalSkillDirectoryReference[],
  original: readonly ExternalSkillDirectoryReference[],
): boolean {
  for (const [index, reference] of canonical.entries()) {
    const originalReference = original[index];
    if (
      originalReference === undefined ||
      skillReferenceKey(reference) !== skillReferenceKey(originalReference)
    ) {
      return true;
    }
  }
  return false;
}

function skillReferenceKey(reference: ExternalSkillDirectoryReference): string {
  return `${reference.directoryId}\u0000${reference.relativeSkillPath}\u0000${reference.revisionDigest}`;
}

function isProxyArray(value: unknown): boolean {
  return typeof value === "object" && value !== null && isProxy(value);
}

export { parseSkillReferences };
