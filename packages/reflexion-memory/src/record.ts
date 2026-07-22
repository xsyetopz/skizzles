import {
  compareStrings,
  digestCanonical,
  isReflexionDigest,
  normalizeIdentifier,
  normalizeText,
} from "./canonical.ts";
import type {
  ExternalSkillDirectoryReference,
  ReflexionCritique,
  ReflexionDigest,
  ReflexionFailure,
  ReflexionFailureRecord,
  ReflexionFailureRecordInput,
  ReflexionOrigin,
} from "./contract.ts";
import { dataRecord, isProxy, strictFrozenArray } from "./object.ts";
import { parseSkillReferences } from "./skill-reference.ts";

const recordKeys = [
  "schema",
  "domain",
  "version",
  "origin",
  "failure",
  "critique",
  "skillReferences",
  "recordDigest",
] as const;
const inputKeys = ["origin", "failure", "critique", "skillReferences"] as const;
const originKeys = ["taskId", "runId"] as const;
const failureKeys = ["kind", "summary", "evidenceDigests"] as const;
const critiqueKeys = ["cause", "correction", "prevention"] as const;
const maximumEvidenceCount = 128;
const maximumFailureSummaryLength = 8192;
const maximumCritiqueTextLength = 16_384;

interface RecordMaterial {
  readonly schema: "skizzles.reflexion-memory/failure-record";
  readonly domain: "reflexion-failure-memory";
  readonly version: 1;
  readonly origin: ReflexionOrigin;
  readonly failure: ReflexionFailure;
  readonly critique: ReflexionCritique;
  readonly skillReferences: readonly ExternalSkillDirectoryReference[];
}

function createReflexionFailureRecord(
  input: ReflexionFailureRecordInput,
): ReflexionFailureRecord {
  const inputRecord = dataRecord(input, inputKeys, false);
  if (inputRecord === undefined) {
    throw new TypeError("failure record inputs must use exact data properties");
  }
  const material = materialFromRecords(inputRecord, false);
  return Object.freeze({
    ...material,
    recordDigest: digestRecordMaterial(material),
  });
}

function parseReflexionFailureRecord(
  value: unknown,
): ReflexionFailureRecord | undefined {
  const record = dataRecord(value, recordKeys, true);
  if (
    record === undefined ||
    record.schema !== "skizzles.reflexion-memory/failure-record" ||
    record.domain !== "reflexion-failure-memory" ||
    record.version !== 1 ||
    !isReflexionDigest(record.recordDigest)
  ) {
    return;
  }
  let material: RecordMaterial;
  try {
    material = materialFromRecords(record, true);
  } catch {
    return;
  }
  if (digestRecordMaterial(material) !== record.recordDigest) {
    return;
  }
  return Object.freeze({ ...material, recordDigest: record.recordDigest });
}

function isReflexionFailureRecord(
  value: unknown,
): value is ReflexionFailureRecord {
  return parseReflexionFailureRecord(value) !== undefined;
}

function materialFromRecords(
  record: Readonly<Record<(typeof inputKeys)[number], unknown>>,
  requireFrozen: boolean,
): RecordMaterial {
  return Object.freeze({
    schema: "skizzles.reflexion-memory/failure-record" as const,
    domain: "reflexion-failure-memory" as const,
    version: 1 as const,
    origin: parseOrigin(record.origin, requireFrozen),
    failure: parseFailure(record.failure, requireFrozen),
    critique: parseCritique(record.critique, requireFrozen),
    skillReferences: parseSkillReferences(
      record.skillReferences,
      requireFrozen,
    ),
  });
}

function parseOrigin(value: unknown, requireFrozen: boolean): ReflexionOrigin {
  const record = dataRecord(value, originKeys, requireFrozen);
  if (record === undefined) {
    throw new TypeError("origins must use exact data properties");
  }
  return Object.freeze({
    taskId: normalizeIdentifier(record.taskId, "taskId"),
    runId: normalizeIdentifier(record.runId, "runId"),
  });
}

function parseFailure(
  value: unknown,
  requireFrozen: boolean,
): ReflexionFailure {
  const record = dataRecord(value, failureKeys, requireFrozen);
  if (record === undefined) {
    throw new TypeError("failures must use exact data properties");
  }
  return Object.freeze({
    kind: normalizeIdentifier(record.kind, "failure kind"),
    summary: normalizeText(
      record.summary,
      "failure summary",
      maximumFailureSummaryLength,
    ),
    evidenceDigests: parseDigestArray(record.evidenceDigests, requireFrozen),
  });
}

function parseCritique(
  value: unknown,
  requireFrozen: boolean,
): ReflexionCritique {
  const record = dataRecord(value, critiqueKeys, requireFrozen);
  if (record === undefined) {
    throw new TypeError("critiques must use exact data properties");
  }
  return Object.freeze({
    cause: normalizeText(
      record.cause,
      "critique cause",
      maximumCritiqueTextLength,
    ),
    correction: normalizeText(
      record.correction,
      "critique correction",
      maximumCritiqueTextLength,
    ),
    prevention: normalizeText(
      record.prevention,
      "critique prevention",
      maximumCritiqueTextLength,
    ),
  });
}

function parseDigestArray(
  value: unknown,
  requireFrozen: boolean,
): readonly ReflexionDigest[] {
  if (isProxyArray(value) || (requireFrozen && !Object.isFrozen(value))) {
    throw new TypeError("evidence digests must be an immutable array");
  }
  let values: unknown = value;
  if (requireFrozen) {
    values = strictFrozenArray(value);
  }
  if (!Array.isArray(values) || values.length > maximumEvidenceCount) {
    throw new TypeError("evidence digest count exceeds its limit");
  }
  const digests: ReflexionDigest[] = [];
  for (const digest of values) {
    if (!isReflexionDigest(digest)) {
      throw new TypeError("evidence must use SHA-256 digests");
    }
    digests.push(digest);
  }
  const canonical = [...digests].sort(compareStrings);
  if (
    new Set(canonical).size !== canonical.length ||
    (requireFrozen &&
      canonical.some((digest, index) => digest !== digests[index]))
  ) {
    throw new TypeError("evidence digests must be unique and canonical");
  }
  return Object.freeze(canonical);
}

function isProxyArray(value: unknown): boolean {
  return typeof value === "object" && value !== null && isProxy(value);
}

function digestRecordMaterial(material: RecordMaterial): ReflexionDigest {
  return digestCanonical({
    schema: material.schema,
    domain: material.domain,
    version: material.version,
    origin: { taskId: material.origin.taskId, runId: material.origin.runId },
    failure: {
      kind: material.failure.kind,
      summary: material.failure.summary,
      evidenceDigests: material.failure.evidenceDigests,
    },
    critique: {
      cause: material.critique.cause,
      correction: material.critique.correction,
      prevention: material.critique.prevention,
    },
    skillReferences: material.skillReferences.map((reference) => ({
      kind: reference.kind,
      access: reference.access,
      directoryId: reference.directoryId,
      relativeSkillPath: reference.relativeSkillPath,
      revisionDigest: reference.revisionDigest,
    })),
  });
}

export {
  createReflexionFailureRecord,
  isReflexionFailureRecord,
  parseReflexionFailureRecord,
};
