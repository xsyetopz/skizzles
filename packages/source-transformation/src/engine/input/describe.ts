import type { DescribeRequest, RepositoryBinding } from "../workflow-state.ts";
import {
  frozenArray,
  frozenRecord,
  identity,
  isDigest,
  sourcePath,
} from "./primitives.ts";

export function parseDescribeRequest(
  value: unknown,
): DescribeRequest | undefined {
  const record = frozenRecord(value, [
    "requestDigest",
    "repository",
    "language",
    "objective",
    "targets",
    "formatterId",
  ]);
  if (record === undefined) return;
  const language = record.get("language");
  const requestDigest = record.get("requestDigest");
  const repository = parseRepository(record.get("repository"));
  const objective = record.get("objective");
  const targets = parseTargetPaths(record.get("targets"));
  const formatterId = record.get("formatterId");
  if (
    !isDigest(requestDigest) ||
    !identity(language) ||
    repository === undefined ||
    (objective !== "behavioral" && objective !== "format-only") ||
    targets === undefined ||
    !identity(formatterId)
  ) {
    return;
  }
  return Object.freeze({
    requestDigest,
    repository,
    language,
    objective,
    targets,
    formatterId,
  });
}

function parseRepository(value: unknown): RepositoryBinding | undefined {
  const record = frozenRecord(value, [
    "id",
    "rootIdentity",
    "treeDigest",
    "configDigest",
  ]);
  const id = record?.get("id");
  const rootIdentity = record?.get("rootIdentity");
  const treeDigest = record?.get("treeDigest");
  const configDigest = record?.get("configDigest");
  if (
    !(
      identity(id, 256) &&
      identity(rootIdentity, 256) &&
      isDigest(treeDigest) &&
      isDigest(configDigest)
    )
  )
    return;
  return Object.freeze({ id, rootIdentity, treeDigest, configDigest });
}

function parseTargetPaths(
  value: unknown,
): readonly { readonly path: string }[] | undefined {
  if (!frozenArray(value) || value.length === 0 || value.length > 256) return;
  const result: { readonly path: string }[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = frozenRecord(item, ["path"]);
    const path = record?.get("path");
    if (!sourcePath(path) || seen.has(path)) return;
    seen.add(path);
    result.push(Object.freeze({ path }));
  }
  return Object.freeze(
    result.sort((left, right) => left.path.localeCompare(right.path)),
  );
}
