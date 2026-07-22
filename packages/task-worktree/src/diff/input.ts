import { types } from "node:util";
import type { TaskWorktreeDigest } from "../digest.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import type {
  DiffCeilings,
  ExactWorktreeChange,
  ExactWorktreeDiffInput,
  TaskWorktreeFileState,
} from "./contract.ts";

export function parseCeilings(input: unknown): DiffCeilings | undefined {
  if (
    !isPlainFrozenRecord(input, [
      "maxAddedLines",
      "maxChangedBytes",
      "maxChangedFiles",
      "maxDeletedLines",
    ])
  )
    return;
  const maxChangedFiles = input["maxChangedFiles"];
  const maxAddedLines = input["maxAddedLines"];
  const maxDeletedLines = input["maxDeletedLines"];
  const maxChangedBytes = input["maxChangedBytes"];
  const values = [
    maxChangedFiles,
    maxAddedLines,
    maxDeletedLines,
    maxChangedBytes,
  ];
  if (
    !values.every(
      (value) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    )
  )
    return;
  if (
    typeof maxChangedFiles !== "number" ||
    typeof maxAddedLines !== "number" ||
    typeof maxDeletedLines !== "number" ||
    typeof maxChangedBytes !== "number"
  )
    return;
  return Object.freeze({
    maxChangedFiles,
    maxAddedLines,
    maxDeletedLines,
    maxChangedBytes,
  });
}

export function parseExactInput(
  input: unknown,
): ExactWorktreeDiffInput | undefined {
  if (!isPlainFrozenRecord(input, ["baseline", "candidate"])) return;
  if (
    !hasDataProperty(input, "baseline") ||
    !hasDataProperty(input, "candidate")
  )
    return;
  const baseline = parseFileStates(input["baseline"]);
  const candidate = parseFileStates(input["candidate"]);
  if (baseline === undefined || candidate === undefined) return;
  return Object.freeze({ baseline, candidate });
}

function parseFileStates(
  input: unknown,
): readonly TaskWorktreeFileState[] | undefined {
  if (!(Array.isArray(input) && Object.isFrozen(input))) return;
  const files: TaskWorktreeFileState[] = [];
  let priorPath: string | undefined;
  for (const entry of input) {
    if (
      !isPlainFrozenRecord(entry, ["bytes", "path"]) ||
      !hasDataProperty(entry, "path") ||
      !hasDataProperty(entry, "bytes")
    )
      return;
    const path = entry["path"];
    const rawBytes = entry["bytes"];
    if (
      typeof path !== "string" ||
      !isSafeRelativePath(path) ||
      (priorPath !== undefined && priorPath >= path)
    )
      return;
    const bytes = parseBytes(rawBytes);
    if (bytes === undefined) return;
    files.push(Object.freeze({ path, bytes }));
    priorPath = path;
  }
  return Object.freeze(files);
}

function parseBytes(input: unknown): readonly number[] | undefined {
  if (!(Array.isArray(input) && Object.isFrozen(input))) return;
  if (
    !input.every(
      (value) =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 255,
    )
  )
    return;
  return Object.freeze([...input]);
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..")
  );
}

export function digestFiles(
  files: readonly TaskWorktreeFileState[],
): TaskWorktreeDigest {
  return digestTaskWorktreeValue(
    files.map(({ path, bytes }) => ({ path, bytes: [...bytes] })),
  );
}

export function digestInput(input: ExactWorktreeDiffInput): TaskWorktreeDigest {
  return digestTaskWorktreeValue({
    baseline: input.baseline,
    candidate: input.candidate,
  });
}

export function digestBytes(bytes: readonly number[]): TaskWorktreeDigest {
  return digestTaskWorktreeValue([...bytes]);
}

export function changeDigest(change: ExactWorktreeChange): TaskWorktreeDigest {
  return digestTaskWorktreeValue(changeMaterial(change));
}

export function changeMaterial(
  change: ExactWorktreeChange,
): Omit<ExactWorktreeChange, "path"> & Readonly<{ path: string }> {
  return {
    path: change.path,
    kind: change.kind,
    baselineDigest: change.baselineDigest,
    candidateDigest: change.candidateDigest,
    baselineBytes: change.baselineBytes,
    candidateBytes: change.candidateBytes,
    addedLines: change.addedLines,
    deletedLines: change.deletedLines,
    binary: change.binary,
  };
}

export function isPlainFrozenRecord(
  input: unknown,
  keys: readonly string[],
): input is Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    !Object.isFrozen(input)
  )
    return false;
  const ownKeys = Reflect.ownKeys(input);
  return (
    ownKeys.length === keys.length && keys.every((key) => ownKeys.includes(key))
  );
}

export function hasDataProperty(
  input: Record<string, unknown>,
  key: string,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && "value" in descriptor;
}
