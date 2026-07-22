import { asRecord, hasExactKeys, parseBoundedString } from "./codec.ts";
import type { TransactionFailure } from "./contracts.ts";
import { isDigest } from "./digest.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

export type RecoveryRequest = Readonly<{
  version: 1;
  repositoryId: string;
  rootIdentity: string;
  ownerId: string;
  transactionId: string;
  requestDigest: string;
  approvalDigest: string;
}>;

type RecoveryParseResult =
  | Readonly<{ ok: true; request: RecoveryRequest }>
  | TransactionFailure;

function malformed(message: string): TransactionFailure {
  return { ok: false, code: "MALFORMED_INPUT", message };
}

export function parseRecoveryRequest(value: unknown): RecoveryParseResult {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, [
      "version",
      "repositoryId",
      "rootIdentity",
      "ownerId",
      "transactionId",
      "requestDigest",
      "approvalDigest",
    ]) ||
    record.version !== 1
  ) {
    return malformed("recovery request envelope is malformed");
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
  if (
    repositoryId === undefined ||
    rootIdentity === undefined ||
    ownerId === undefined ||
    !isDigest(record.transactionId) ||
    !isDigest(record.requestDigest) ||
    !isDigest(record.approvalDigest)
  ) {
    return malformed("recovery bindings are malformed");
  }
  return {
    ok: true,
    request: {
      version: 1,
      repositoryId,
      rootIdentity,
      ownerId,
      transactionId: record.transactionId,
      requestDigest: record.requestDigest,
      approvalDigest: record.approvalDigest,
    },
  };
}
