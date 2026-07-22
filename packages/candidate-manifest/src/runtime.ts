import { createHash } from "node:crypto";

import type {
  CandidateManifest,
  CandidateManifestDigest,
  CandidateManifestEntry,
  CandidateManifestOperation,
} from "./contract.ts";
import {
  assertDistinctCanonicalPaths,
  compareEntries,
  hasCanonicalEntries,
} from "./entries.ts";
import { dataRecord, isProxy, strictFrozenArray } from "./object.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const drivePrefixPattern = /^[A-Za-z]:/u;
const maximumPathLength = 4096;
const maximumEntryCount = 4096;
const manifestKeys = [
  "schema",
  "domain",
  "version",
  "entries",
  "manifestDigest",
] as const;
const entryKeys = ["path", "operation", "contentDigest"] as const;

/**
 * Canonicalizes trusted typed file changes into an immutable manifest. This
 * validates syntax and stable representation, but does not attest to a
 * caller's authority over the candidate files or their content digests.
 */
function createCandidateManifest(
  entries: readonly CandidateManifestEntry[],
): CandidateManifest {
  if (isProxy(entries)) {
    throw new TypeError("candidate manifest entries must not be a proxy");
  }
  if (entries.length === 0) {
    throw new TypeError("candidate manifests must contain at least one entry");
  }
  if (entries.length > maximumEntryCount) {
    throw new TypeError("candidate manifest entry count exceeds its limit");
  }
  const normalized = entries.map((entry) => {
    const record = dataRecord(entry, entryKeys, false);
    if (record === undefined) {
      throw new TypeError(
        "candidate manifest entries must use data properties",
      );
    }
    return normalizeEntryRecord(record);
  });
  normalized.sort(compareEntries);
  assertDistinctCanonicalPaths(normalized);
  const immutableEntries = Object.freeze(
    normalized.map((entry) => Object.freeze(entry)),
  );
  const material = Object.freeze({
    schema: "skizzles.candidate-manifest/manifest" as const,
    domain: "candidate-file-manifest" as const,
    version: 1 as const,
    entries: immutableEntries,
  });
  return Object.freeze({
    ...material,
    manifestDigest: digestMaterial(material),
  });
}

/**
 * Strictly validates a frozen, already-canonical manifest received at a trust
 * boundary. Unlike creation, this rejects order drift rather than repairing it.
 */
function parseCandidateManifest(value: unknown): CandidateManifest | undefined {
  const record = dataRecord(value, manifestKeys, true);
  if (
    record === undefined ||
    record.schema !== "skizzles.candidate-manifest/manifest" ||
    record.domain !== "candidate-file-manifest" ||
    record.version !== 1 ||
    !isCandidateManifestDigest(record.manifestDigest)
  ) {
    return;
  }
  const entries = strictFrozenArray(record.entries);
  if (entries === undefined) {
    return;
  }
  const parsed: CandidateManifestEntry[] = [];
  for (const entry of entries) {
    const parsedEntry = parseEntry(entry);
    if (parsedEntry === undefined) {
      return;
    }
    parsed.push(parsedEntry);
  }
  if (!hasCanonicalEntries(parsed, maximumEntryCount)) {
    return;
  }
  const material = Object.freeze({
    schema: "skizzles.candidate-manifest/manifest" as const,
    domain: "candidate-file-manifest" as const,
    version: 1 as const,
    entries: Object.freeze(parsed),
  });
  if (digestMaterial(material) !== record.manifestDigest) {
    return;
  }
  return value as CandidateManifest;
}

function isCandidateManifest(value: unknown): value is CandidateManifest {
  return parseCandidateManifest(value) !== undefined;
}

function isCandidateManifestDigest(
  value: unknown,
): value is CandidateManifestDigest {
  return typeof value === "string" && digestPattern.test(value);
}

function parseEntry(value: unknown): CandidateManifestEntry | undefined {
  const record = dataRecord(value, entryKeys, true);
  if (record === undefined) {
    return;
  }
  let entry: CandidateManifestEntry | undefined;
  try {
    entry = normalizeEntryRecord(record);
  } catch {
    // An invalid untrusted entry does not produce a manifest.
  }
  if (
    entry === undefined ||
    entry.path !== record.path ||
    entry.operation !== record.operation ||
    entry.contentDigest !== record.contentDigest
  ) {
    return;
  }
  return entry;
}

function normalizeEntryRecord(
  record: Readonly<Record<(typeof entryKeys)[number], unknown>>,
): CandidateManifestEntry {
  const operation = parseOperation(record.operation);
  return {
    path: normalizeRelativePath(record.path),
    operation,
    contentDigest: parseContentDigest(operation, record.contentDigest),
  };
}

function parseOperation(value: unknown): CandidateManifestOperation {
  if (value === "delete" || value === "write") {
    return value;
  }
  throw new TypeError("candidate manifest operation must be delete or write");
}

function parseContentDigest(
  operation: CandidateManifestOperation,
  value: unknown,
): CandidateManifestDigest | null {
  if (operation === "delete") {
    if (value === null) {
      return null;
    }
    throw new TypeError(
      "candidate manifest deletes must have a null content digest",
    );
  }
  if (isCandidateManifestDigest(value)) {
    return value;
  }
  throw new TypeError(
    "candidate manifest writes must have a SHA-256 content digest",
  );
}

function normalizeRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumPathLength
  ) {
    throw new TypeError("candidate manifest paths must be bounded strings");
  }
  if (value !== value.normalize("NFC")) {
    throw new TypeError("candidate manifest paths must be NFC normalized");
  }
  if (
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    drivePrefixPattern.test(value)
  ) {
    throw new TypeError(
      "candidate manifest paths must be portable relative paths",
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError(
      "candidate manifest paths must not contain aliases or traversal",
    );
  }
  return value;
}

function digestMaterial(value: {
  readonly schema: "skizzles.candidate-manifest/manifest";
  readonly domain: "candidate-file-manifest";
  readonly version: 1;
  readonly entries: readonly CandidateManifestEntry[];
}): CandidateManifestDigest {
  const canonical = JSON.stringify({
    schema: value.schema,
    domain: value.domain,
    version: value.version,
    entries: value.entries.map((entry) => ({
      path: entry.path,
      operation: entry.operation,
      contentDigest: entry.contentDigest,
    })),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export {
  createCandidateManifest,
  isCandidateManifest,
  isCandidateManifestDigest,
  parseCandidateManifest,
};
