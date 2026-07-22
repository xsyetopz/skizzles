import {
  asRecord,
  compareCanonicalText,
  hasExactKeys,
  normalizeTargetPath,
  parseBoundedString,
  parseByteArray,
  snapshotArray,
} from "./codec.ts";
import type {
  ApprovalBindings,
  ExpectedSnapshot,
  FileSnapshot,
  TransactionFailure,
} from "./contracts.ts";
import { digestBytes, digestValue, isDigest } from "./digest.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const MAX_TARGETS = 256;
const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export type WriteTarget = Readonly<{
  path: string;
  operation: "write";
  expected: ExpectedSnapshot;
  candidateBytes: Uint8Array;
  candidateDigest: string;
}>;

export type DeleteTarget = Readonly<{
  path: string;
  operation: "delete";
  expected: FileSnapshot;
}>;

export type TransactionTarget = WriteTarget | DeleteTarget;

export type TransactionRequest = Readonly<{
  version: 1;
  repositoryId: string;
  rootIdentity: string;
  ownerId: string;
  approvalReference: string;
  targets: readonly TransactionTarget[];
  requestDigest: string;
  targetSetDigest: string;
  baselineDigest: string;
  approvalBindings: ApprovalBindings;
}>;

type ParseResult =
  | Readonly<{ ok: true; request: TransactionRequest }>
  | TransactionFailure;
type TargetParseResult =
  | Readonly<{ ok: true; target: TransactionTarget }>
  | TransactionFailure;

function failure(
  code: TransactionFailure["code"],
  message: string,
): TransactionFailure {
  return { ok: false, code, message };
}

function parseExpected(value: unknown): ExpectedSnapshot | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.state !== "string") {
    return;
  }
  if (record.state === "missing") {
    return hasExactKeys(record, ["state"]) ? { state: "missing" } : undefined;
  }
  if (
    record.state !== "file" ||
    !hasExactKeys(record, [
      "state",
      "identity",
      "deviceId",
      "byteLength",
      "contentDigest",
      "linkCount",
    ])
  ) {
    return;
  }
  const identity = parseBoundedString(record.identity, {
    max: 256,
    pattern: ID_PATTERN,
  });
  const deviceId = parseBoundedString(record.deviceId, {
    max: 256,
    pattern: ID_PATTERN,
  });
  if (
    identity === undefined ||
    deviceId === undefined ||
    !Number.isSafeInteger(record.byteLength) ||
    (record.byteLength as number) < 0 ||
    !isDigest(record.contentDigest) ||
    record.linkCount !== 1
  ) {
    return;
  }
  return {
    state: "file",
    identity,
    deviceId,
    byteLength: record.byteLength as number,
    contentDigest: record.contentDigest,
    linkCount: 1,
  };
}

function parseTarget(value: unknown): TargetParseResult {
  const record = asRecord(value);
  if (record === undefined) {
    return failure("MALFORMED_INPUT", "target must be a plain object");
  }
  const path = normalizeTargetPath(record.path);
  if (path === undefined) {
    return failure(
      "PATH_ESCAPE",
      "target path is not a contained relative path",
    );
  }
  const expected = parseExpected(record.expected);
  if (expected === undefined) {
    return failure("MALFORMED_INPUT", "target baseline is malformed");
  }
  if (record.operation === "delete") {
    if (
      !hasExactKeys(record, ["path", "operation", "expected"]) ||
      expected.state !== "file"
    ) {
      return failure(
        "MALFORMED_INPUT",
        "delete targets require an existing file baseline",
      );
    }
    return { ok: true, target: { path, operation: "delete", expected } };
  }
  if (
    record.operation !== "write" ||
    !hasExactKeys(record, ["path", "operation", "expected", "candidateBytes"])
  ) {
    return failure("MALFORMED_INPUT", "write target shape is malformed");
  }
  const candidateBytes = parseByteArray(
    record.candidateBytes,
    MAX_CANDIDATE_BYTES,
  );
  if (candidateBytes === undefined) {
    return failure(
      "MALFORMED_INPUT",
      "candidate bytes are malformed or exceed the per-file limit",
    );
  }
  return {
    ok: true,
    target: {
      path,
      operation: "write",
      expected,
      candidateBytes,
      candidateDigest: digestBytes(candidateBytes),
    },
  };
}

function targetDescriptor(target: TransactionTarget): unknown {
  return target.operation === "write"
    ? {
        path: target.path,
        operation: target.operation,
        expected: target.expected,
        candidateDigest: target.candidateDigest,
        candidateByteLength: target.candidateBytes.byteLength,
      }
    : {
        path: target.path,
        operation: target.operation,
        expected: target.expected,
      };
}

export function parseTransactionRequest(value: unknown): ParseResult {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, [
      "version",
      "repositoryId",
      "rootIdentity",
      "ownerId",
      "approvalReference",
      "targets",
    ]) ||
    record.version !== 1
  ) {
    return failure(
      "MALFORMED_INPUT",
      "transaction request envelope is malformed",
    );
  }
  const repositoryId = parseBoundedString(record.repositoryId, {
    max: 256,
    pattern: ID_PATTERN,
  });
  const rootIdentity = parseBoundedString(record.rootIdentity, {
    max: 256,
    pattern: ID_PATTERN,
  });
  const ownerId = parseBoundedString(record.ownerId, {
    max: 256,
    pattern: ID_PATTERN,
  });
  const approvalReference = parseBoundedString(record.approvalReference, {
    max: 512,
    pattern: ID_PATTERN,
  });
  const targetValues = snapshotArray(record.targets, MAX_TARGETS);
  if (
    repositoryId === undefined ||
    rootIdentity === undefined ||
    ownerId === undefined ||
    approvalReference === undefined ||
    targetValues === undefined ||
    targetValues.length === 0
  ) {
    return failure("MALFORMED_INPUT", "transaction request fields are invalid");
  }

  const targets: TransactionTarget[] = [];
  let totalBytes = 0;
  const paths = new Set<string>();
  for (const candidate of targetValues) {
    const parsed = parseTarget(candidate);
    if (parsed.ok === false) {
      return parsed;
    }
    const target = parsed.target;
    if (paths.has(target.path)) {
      return failure(
        "DUPLICATE_TARGET",
        `duplicate normalized target: ${target.path}`,
      );
    }
    paths.add(target.path);
    if (target.operation === "write") {
      totalBytes += target.candidateBytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        return failure(
          "MALFORMED_INPUT",
          "candidate bytes exceed the transaction limit",
        );
      }
    }
    targets.push(target);
  }
  targets.sort((left, right) => compareCanonicalText(left.path, right.path));
  const targetDescriptors = targets.map(targetDescriptor);
  const targetSetDigest = digestValue(
    targetDescriptors.map((target) => ({
      path: (target as { path: string }).path,
      operation: (target as { operation: string }).operation,
    })),
  );
  const baselineDigest = digestValue(
    targets.map((target) => ({ path: target.path, expected: target.expected })),
  );
  const requestDigest = digestValue({
    version: 1,
    repositoryId,
    rootIdentity,
    ownerId,
    approvalReference,
    targets: targetDescriptors,
  });
  const approvalBindings = {
    approvalReference,
    repositoryId,
    rootIdentity,
    ownerId,
    requestDigest,
    targetSetDigest,
    baselineDigest,
  } satisfies ApprovalBindings;
  return {
    ok: true,
    request: {
      version: 1,
      repositoryId,
      rootIdentity,
      ownerId,
      approvalReference,
      targets,
      requestDigest,
      targetSetDigest,
      baselineDigest,
      approvalBindings,
    },
  };
}
