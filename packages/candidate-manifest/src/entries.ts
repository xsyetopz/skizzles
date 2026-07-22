import type { CandidateManifestEntry } from "./contract.ts";

const maximumAggregatePathLength = 65_536;

function hasCanonicalEntries(
  entries: readonly CandidateManifestEntry[],
  maximumEntryCount: number,
): boolean {
  if (entries.length === 0 || entries.length > maximumEntryCount) {
    return false;
  }
  let totalPathLength = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      return false;
    }
    totalPathLength += entry.path.length;
    if (totalPathLength > maximumAggregatePathLength) {
      return false;
    }
    if (index > 0) {
      const previous = entries[index - 1];
      if (
        previous === undefined ||
        compareEntries(previous, entry) >= 0 ||
        caseFoldPath(previous.path) === caseFoldPath(entry.path)
      ) {
        return false;
      }
    }
  }
  return true;
}

function assertDistinctCanonicalPaths(
  entries: readonly CandidateManifestEntry[],
): void {
  let totalPathLength = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      throw new TypeError("candidate manifest entries must be present");
    }
    totalPathLength += entry.path.length;
    if (totalPathLength > maximumAggregatePathLength) {
      throw new TypeError(
        "candidate manifest paths exceed their aggregate limit",
      );
    }
    const previous = entries[index - 1];
    if (
      previous !== undefined &&
      caseFoldPath(previous.path) === caseFoldPath(entry.path)
    ) {
      throw new TypeError("candidate manifest paths must be unique");
    }
  }
}

function compareEntries(
  left: CandidateManifestEntry,
  right: CandidateManifestEntry,
): number {
  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  return 0;
}

function caseFoldPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

export { assertDistinctCanonicalPaths, compareEntries, hasCanonicalEntries };
