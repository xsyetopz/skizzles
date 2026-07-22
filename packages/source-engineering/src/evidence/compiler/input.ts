import { resolve } from "node:path";
import { types } from "node:util";
import { digestBytes } from "../../digest.ts";
import type {
  ParsedCandidateOverlay,
  ParsedCompilerInput,
  TrustedCompilerState,
} from "./authority-state.ts";
import type { CompilerEvidenceBindings } from "./contract.ts";
import {
  exactRecord,
  inside,
  validDigest,
  validId,
  validPath,
} from "./input-validation.ts";

const bytesPerMebibyte = 1024 * 1024;
const maximumCandidateBytes = 4 * bytesPerMebibyte;
const maximumBatchBytes = 32 * bytesPerMebibyte;
const maximumTargets = 4096;
const maximumRepositoryIdentityLength = 256;
const maximumProfileIdentityLength = 128;
const maximumByte = 255;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function parseCompilerInput(
  value: unknown,
  state: TrustedCompilerState,
): ParsedCompilerInput | "stale" | "candidate-stale" | undefined {
  const record = exactRecord(value, [
    "requestDigest",
    "repositoryId",
    "rootIdentity",
    "treeDigest",
    "configDigest",
    "targetPath",
    "candidateDigest",
    "semanticDigest",
    "profileId",
    "toolId",
    "toolVersion",
    "targets",
  ]);
  if (record === undefined) return;
  const bindings = parseBindings(record);
  if (bindings === undefined) return;
  if (!matchesState(bindings, state)) return "stale";
  const targets = parseTargets(record.get("targets"), state.rootPath);
  if (targets === undefined || targets === "candidate-stale") return targets;
  const selected = targets.find(({ path }) => path === bindings.targetPath);
  if (
    selected === undefined ||
    selected.candidateDigest !== bindings.candidateDigest ||
    selected.semanticDigest !== bindings.semanticDigest
  )
    return "candidate-stale";
  return Object.freeze({ bindings, targets });
}

function parseTargets(
  value: unknown,
  root: string,
): readonly ParsedCandidateOverlay[] | "candidate-stale" | undefined {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    value.length === 0 ||
    value.length > maximumTargets
  )
    return;
  const targets: ParsedCandidateOverlay[] = [];
  let totalBytes = 0;
  for (const raw of value) {
    const parsed = parseTarget(raw, root);
    if (parsed === undefined || parsed === "candidate-stale") return parsed;
    totalBytes += parsed.candidateBytes.byteLength;
    if (
      totalBytes > maximumBatchBytes ||
      targets.some(({ path }) => path === parsed.path)
    )
      return;
    targets.push(parsed);
  }
  targets.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(targets);
}

function parseBindings(
  record: ReadonlyMap<string, unknown>,
): CompilerEvidenceBindings | undefined {
  const requestDigest = record.get("requestDigest");
  const repositoryId = record.get("repositoryId");
  const rootIdentity = record.get("rootIdentity");
  const treeDigest = record.get("treeDigest");
  const configDigest = record.get("configDigest");
  const targetPath = record.get("targetPath");
  const candidateDigest = record.get("candidateDigest");
  const semanticDigest = record.get("semanticDigest");
  const profileId = record.get("profileId");
  if (
    !(
      validDigest(requestDigest) &&
      validId(repositoryId, maximumRepositoryIdentityLength) &&
      validId(rootIdentity, maximumRepositoryIdentityLength) &&
      validDigest(treeDigest) &&
      validDigest(configDigest) &&
      validPath(targetPath) &&
      validDigest(candidateDigest) &&
      validDigest(semanticDigest) &&
      validId(profileId, maximumProfileIdentityLength)
    ) ||
    record.get("toolId") !== "typescript" ||
    record.get("toolVersion") !== "7.0.2"
  )
    return;
  return Object.freeze({
    requestDigest,
    repositoryId,
    rootIdentity,
    treeDigest,
    configDigest,
    targetPath,
    candidateDigest,
    semanticDigest,
    profileId,
    toolId: "typescript",
    toolVersion: "7.0.2",
  });
}

function parseTarget(
  value: unknown,
  root: string,
): ParsedCandidateOverlay | "candidate-stale" | undefined {
  const record = exactRecord(value, [
    "path",
    "candidateDigest",
    "semanticDigest",
    "candidateBytes",
  ]);
  const path = record?.get("path");
  const candidateDigest = record?.get("candidateDigest");
  const semanticDigest = record?.get("semanticDigest");
  const rawBytes = record?.get("candidateBytes");
  if (
    !(
      validPath(path) &&
      validDigest(candidateDigest) &&
      validDigest(semanticDigest) &&
      Array.isArray(rawBytes)
    ) ||
    types.isProxy(rawBytes) ||
    rawBytes.length > maximumCandidateBytes
  )
    return;
  const candidateBytes = new Uint8Array(rawBytes.length);
  for (let index = 0; index < rawBytes.length; index += 1) {
    const byte = rawBytes[index];
    if (
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > maximumByte
    )
      return;
    candidateBytes[index] = byte;
  }
  if (digestBytes(candidateBytes) !== candidateDigest) return "candidate-stale";
  try {
    const absolutePath = resolve(root, path);
    if (!inside(root, absolutePath)) return;
    return Object.freeze({
      path,
      absolutePath,
      candidateDigest,
      semanticDigest,
      candidateBytes,
      sourceText: decoder.decode(candidateBytes),
    });
  } catch {
    return undefined;
  }
}

function matchesState(
  bindings: CompilerEvidenceBindings,
  state: TrustedCompilerState,
): boolean {
  const trusted = state.bindings;
  return (
    bindings.repositoryId === trusted.repositoryId &&
    bindings.rootIdentity === trusted.rootIdentity &&
    bindings.treeDigest === trusted.treeDigest &&
    bindings.configDigest === trusted.configDigest &&
    bindings.profileId === trusted.profileId &&
    bindings.toolId === trusted.toolId &&
    bindings.toolVersion === trusted.toolVersion
  );
}
