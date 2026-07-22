import { types } from "node:util";
import type {
  TaskWorktreeChange,
  TaskWorktreePrepareInput,
} from "../../contract.ts";
import type { TaskWorktreeDigest } from "../../digest.ts";
import { isSafeRelativePath } from "../../policy/value.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const taskPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function parsePrepareInput(
  input: unknown,
): TaskWorktreePrepareInput | undefined {
  const values = exactRecord(input, [
    "baselineDigest",
    "changes",
    "repositoryId",
    "requestDigest",
    "rootIdentity",
    "taskId",
    "taskEpochDigest",
    "treeDigest",
  ]);
  if (values === undefined || !Object.isFrozen(input)) return;
  const taskId = values.get("taskId");
  const taskEpochDigest = values.get("taskEpochDigest");
  const requestDigest = values.get("requestDigest");
  const repositoryId = values.get("repositoryId");
  const rootIdentity = values.get("rootIdentity");
  const treeDigest = values.get("treeDigest");
  const baselineDigest = values.get("baselineDigest");
  const changes = parseChanges(values.get("changes"));
  if (
    typeof taskId !== "string" ||
    !taskPattern.test(taskId) ||
    !isDigest(taskEpochDigest) ||
    !isDigest(requestDigest) ||
    !identity(repositoryId) ||
    !identity(rootIdentity) ||
    !isDigest(treeDigest) ||
    !isDigest(baselineDigest) ||
    changes === undefined
  ) {
    return;
  }
  return Object.freeze({
    taskId,
    taskEpochDigest,
    requestDigest,
    repositoryId,
    rootIdentity,
    treeDigest,
    baselineDigest,
    changes,
  });
}
function parseChanges(
  value: unknown,
): readonly TaskWorktreeChange[] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    value.length === 0 ||
    value.length > 256
  ) {
    return;
  }
  const changes: TaskWorktreeChange[] = [];
  const canonicalPaths = new Set<string>();
  let previous = "";
  for (const raw of value) {
    const values = exactRecord(raw, [
      "baselineDigest",
      "candidateBytes",
      "operation",
      "path",
    ]);
    if (values === undefined || !Object.isFrozen(raw)) return;
    const path = values.get("path");
    const operation = values.get("operation");
    const baselineDigest = values.get("baselineDigest");
    const candidateBytes = parseBytes(values.get("candidateBytes"));
    if (
      typeof path !== "string" ||
      !isSafeRelativePath(path) ||
      path !== path.normalize("NFC") ||
      path <= previous ||
      (operation !== "write" && operation !== "delete") ||
      (baselineDigest !== null && !isDigest(baselineDigest)) ||
      (operation === "write" && candidateBytes === undefined) ||
      (operation === "delete" && values.get("candidateBytes") !== null)
    ) {
      return;
    }
    const canonicalPath = path.toLowerCase();
    if (canonicalPaths.has(canonicalPath)) return;
    canonicalPaths.add(canonicalPath);
    previous = path;
    changes.push(
      Object.freeze({
        path,
        operation,
        baselineDigest,
        candidateBytes:
          operation === "delete" ? null : (candidateBytes ?? null),
      }),
    );
  }
  return Object.freeze(changes);
}

function parseBytes(value: unknown): readonly number[] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    value.length > 16 * 1024 * 1024
  )
    return;
  const bytes: number[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "number" ||
      !Number.isInteger(entry) ||
      entry < 0 ||
      entry > 255
    )
      return;
    bytes.push(entry);
  }
  return Object.freeze(bytes);
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    return;
  const values = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    values.set(key, descriptor.value);
  }
  return values;
}

function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u.test(value)
  );
}

function isDigest(value: unknown): value is TaskWorktreeDigest {
  return typeof value === "string" && digestPattern.test(value);
}
