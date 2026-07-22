import { type Digest, digestValue } from "../../digest.ts";
import type { SchedulerRunRequest, SchedulerTask } from "./contract.ts";

const maximumTasks = 10_000;
const maximumIdentityLength = 128;
const maximumPathLength = 1024;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export interface ParsedSchedule {
  readonly request: SchedulerRunRequest;
  readonly requestDigest: Digest;
  readonly tasksById: ReadonlyMap<string, SchedulerTask>;
}

export function parseSchedule(input: unknown): ParsedSchedule | undefined {
  const record = exactFrozenRecord(input, ["version", "executionId", "tasks"]);
  if (record === undefined || record.get("version") !== 1) return;
  const executionId = identity(record.get("executionId"));
  const rawTasks = record.get("tasks");
  if (
    executionId === undefined ||
    !Array.isArray(rawTasks) ||
    !Object.isFrozen(rawTasks) ||
    rawTasks.length === 0 ||
    rawTasks.length > maximumTasks
  ) {
    return;
  }
  const tasks: SchedulerTask[] = [];
  const tasksById = new Map<string, SchedulerTask>();
  for (const rawTask of rawTasks) {
    const task = parseTask(rawTask);
    if (task === undefined || tasksById.has(task.id)) return;
    tasks.push(task);
    tasksById.set(task.id, task);
  }
  for (const task of tasks) {
    if (
      task.dependencies.includes(task.id) ||
      task.dependencies.some((dependency) => !tasksById.has(dependency))
    ) {
      return;
    }
  }
  if (containsCycle(tasksById)) return;
  const orderedTasks = Object.freeze(
    [...tasks].sort((left, right) => compareText(left.id, right.id)),
  );
  const request = Object.freeze({
    version: 1 as const,
    executionId,
    tasks: orderedTasks,
  });
  return Object.freeze({
    request,
    requestDigest: digestValue(request),
    tasksById: new Map(orderedTasks.map((task) => [task.id, task])),
  });
}

function parseTask(value: unknown): SchedulerTask | undefined {
  const record = exactFrozenRecord(value, [
    "access",
    "dependencies",
    "id",
    "objectiveDigest",
    "repositoryId",
    "writePaths",
  ]);
  if (record === undefined) return;
  const id = identity(record.get("id"));
  const repositoryId = identity(record.get("repositoryId"));
  const objectiveDigest = digest(record.get("objectiveDigest"));
  const access = record.get("access");
  const dependencies = identities(record.get("dependencies"));
  const writePaths = paths(record.get("writePaths"));
  if (
    id === undefined ||
    repositoryId === undefined ||
    objectiveDigest === undefined ||
    (access !== "read-only" && access !== "isolated-write") ||
    dependencies === undefined ||
    writePaths === undefined ||
    (access === "read-only" && writePaths.length !== 0) ||
    (access === "isolated-write" && writePaths.length === 0)
  ) {
    return;
  }
  return Object.freeze({
    id,
    repositoryId,
    access,
    objectiveDigest,
    dependencies,
    writePaths,
  });
}

function identities(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !Object.isFrozen(value)) return;
  const result: string[] = [];
  for (const item of value) {
    const parsed = identity(item);
    if (parsed === undefined || result.includes(parsed)) return;
    result.push(parsed);
  }
  return Object.freeze(result.sort(compareText));
}

function paths(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !Object.isFrozen(value)) return;
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !relativePath(item) ||
      result.includes(item)
    ) {
      return;
    }
    result.push(item);
  }
  return Object.freeze(result.sort(compareText));
}

function relativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > maximumPathLength ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function containsCycle(tasks: ReadonlyMap<string, SchedulerTask>): boolean {
  const indegrees = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks.values()) {
    indegrees.set(task.id, task.dependencies.length);
    for (const dependency of task.dependencies) {
      const entries = dependents.get(dependency) ?? [];
      entries.push(task.id);
      dependents.set(dependency, entries);
    }
  }
  const ready = [...indegrees.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const id = ready[cursor];
    if (id === undefined) return true;
    visited += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const degree = indegrees.get(dependent);
      if (degree === undefined) return true;
      indegrees.set(dependent, degree - 1);
      if (degree === 1) ready.push(dependent);
    }
  }
  return visited !== tasks.size;
}

function exactFrozenRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value)) {
    return;
  }
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return;
  }
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return;
  }
  const result = new Map<string, unknown>();
  for (const key of expectedKeys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return;
    }
    if (descriptor === undefined || !("value" in descriptor)) return;
    result.set(key, descriptor.value);
  }
  return result;
}

function identity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumIdentityLength &&
    identityPattern.test(value)
    ? value
    : undefined;
}

function digest(value: unknown): Digest | undefined {
  return typeof value === "string" && digestPattern.test(value)
    ? (value as Digest)
    : undefined;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
