import { posix } from "node:path";
import { isNormalizedRequest, type NormalizedRequest } from "../intent.ts";
import { isRepositoryContext, type RepositoryContext } from "../repository.ts";
import type { EngineeringValidationProfile } from "./contract.ts";
import { snapshotArray, snapshotRecord } from "./snapshot.ts";

const maximumTargets = 64;

export interface ParsedDescribeInput {
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly targets: readonly string[];
  readonly profile: EngineeringValidationProfile;
}

export function parseDescribeInput(
  input: unknown,
  profiles: readonly EngineeringValidationProfile[],
): ParsedDescribeInput | undefined {
  const value = snapshotRecord(input, [
    "request",
    "repository",
    "targets",
    "validationProfile",
  ]);
  if (
    !(
      value !== undefined &&
      isNormalizedRequest(value["request"]) &&
      isRepositoryContext(value["repository"]) &&
      value["request"].intentDigest === value["repository"].requestDigest &&
      typeof value["validationProfile"] === "string"
    )
  ) {
    return;
  }
  const targetValues = snapshotArray(value["targets"], maximumTargets);
  const profile = profiles.find(
    (candidate) => candidate.id === value["validationProfile"],
  );
  if (
    targetValues === undefined ||
    targetValues.length === 0 ||
    profile === undefined
  ) {
    return;
  }
  const targets = targetValues.map(normalizePath);
  if (
    targets.some((target) => target === undefined) ||
    new Set(targets).size !== targets.length
  ) {
    return;
  }
  return Object.freeze({
    request: value["request"],
    repository: value["repository"],
    targets: Object.freeze(
      targets
        .filter((target): target is string => target !== undefined)
        .sort((left, right) => left.localeCompare(right)),
    ),
    profile,
  });
}

function normalizePath(input: unknown): string | undefined {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 1024 ||
    input.startsWith("/") ||
    input.includes("\\") ||
    input.includes("\0")
  ) {
    return;
  }
  const normalized = posix.normalize(input);
  if (
    normalized !== input ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return;
  }
  return normalized;
}
