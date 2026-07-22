import {
  asRecord,
  bytesEqual,
  compareCanonicalText,
  hasExactKeys,
  normalizeTargetPath,
  parseBoundedString,
} from "../protocol/codec.ts";
import type {
  ApprovalBindings,
  ExpectedSnapshot,
  FileSnapshot,
  JournalState,
  TransactionFailure,
} from "../protocol/contracts.ts";
import {
  canonicalJson,
  digestText,
  digestValue,
  isDigest,
} from "../protocol/digest.ts";
import type {
  TransactionRequest,
  TransactionTarget,
} from "../protocol/request.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const JOURNAL_STATES = new Set<JournalState>([
  "preparing",
  "prepared",
  "publishing",
  "committed",
  "cleanup-pending",
]);

export type JournalTarget = Readonly<{
  path: string;
  operation: "write" | "delete";
  expected: ExpectedSnapshot;
  candidate: Readonly<{
    name: string;
    contentDigest: string;
    byteLength: number;
    identity: string | null;
    deviceId: string | null;
  }> | null;
  retiredName: string | null;
}>;

export type TransactionJournal = Readonly<{
  version: 1;
  transactionId: string;
  state: JournalState;
  approvalDigest: string;
  bindings: ApprovalBindings;
  targets: readonly JournalTarget[];
  journalDigest: string;
}>;

type JournalDecodeResult =
  | Readonly<{ ok: true; journal: TransactionJournal }>
  | TransactionFailure;

function ownedSiblingName(
  transactionId: string,
  target: TransactionTarget,
  role: "candidate" | "retired",
): string {
  const pathDigest = digestText(target.path);
  return `.skizzles-transaction-${transactionId}-${pathDigest}-${role}`;
}

function targetToJournal(
  transactionId: string,
  target: TransactionTarget,
): JournalTarget {
  if (target.operation === "write") {
    return {
      path: target.path,
      operation: "write",
      expected: target.expected,
      candidate: {
        name: ownedSiblingName(transactionId, target, "candidate"),
        contentDigest: target.candidateDigest,
        byteLength: target.candidateBytes.byteLength,
        identity: null,
        deviceId: null,
      },
      retiredName: null,
    };
  }
  return {
    path: target.path,
    operation: "delete",
    expected: target.expected,
    candidate: null,
    retiredName: ownedSiblingName(transactionId, target, "retired"),
  };
}

function digestPayload(
  journal: Omit<TransactionJournal, "journalDigest">,
): string {
  return digestValue(journal);
}

export function createJournal(
  request: TransactionRequest,
  approvalDigest: string,
): TransactionJournal {
  const transactionId = digestValue({
    requestDigest: request.requestDigest,
    approvalDigest,
  });
  const payload = {
    version: 1,
    transactionId,
    state: "preparing",
    approvalDigest,
    bindings: request.approvalBindings,
    targets: request.targets.map((target) =>
      targetToJournal(transactionId, target),
    ),
  } as const;
  return { ...payload, journalDigest: digestPayload(payload) };
}

export function transitionJournal(
  journal: TransactionJournal,
  state: JournalState,
): TransactionJournal {
  const payload = {
    version: 1,
    transactionId: journal.transactionId,
    state,
    approvalDigest: journal.approvalDigest,
    bindings: journal.bindings,
    targets: journal.targets,
  } as const;
  return { ...payload, journalDigest: digestPayload(payload) };
}

export function bindJournalCandidate(
  journal: TransactionJournal,
  targetPath: string,
  identity: string,
  deviceId: string,
): TransactionJournal {
  const targets = journal.targets.map((target) =>
    target.path === targetPath && target.candidate !== null
      ? { ...target, candidate: { ...target.candidate, identity, deviceId } }
      : target,
  );
  const payload = {
    version: 1,
    transactionId: journal.transactionId,
    state: journal.state,
    approvalDigest: journal.approvalDigest,
    bindings: journal.bindings,
    targets,
  } as const;
  return { ...payload, journalDigest: digestPayload(payload) };
}

export function encodeJournal(journal: TransactionJournal): Uint8Array {
  return new TextEncoder().encode(canonicalJson(journal));
}

function parseFileSnapshot(value: unknown): FileSnapshot | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, [
      "state",
      "identity",
      "deviceId",
      "byteLength",
      "contentDigest",
      "linkCount",
    ]) ||
    record.state !== "file" ||
    typeof record.identity !== "string" ||
    typeof record.deviceId !== "string" ||
    !Number.isSafeInteger(record.byteLength) ||
    (record.byteLength as number) < 0 ||
    !isDigest(record.contentDigest) ||
    record.linkCount !== 1
  ) {
    return;
  }
  return {
    state: "file",
    identity: record.identity,
    deviceId: record.deviceId,
    byteLength: record.byteLength as number,
    contentDigest: record.contentDigest,
    linkCount: 1,
  };
}

function parseExpected(value: unknown): ExpectedSnapshot | undefined {
  const record = asRecord(value);
  if (
    record !== undefined &&
    hasExactKeys(record, ["state"]) &&
    record.state === "missing"
  ) {
    return { state: "missing" };
  }
  return parseFileSnapshot(value);
}

function parseBindings(value: unknown): ApprovalBindings | undefined {
  const record = asRecord(value);
  const keys = [
    "approvalReference",
    "repositoryId",
    "rootIdentity",
    "ownerId",
    "requestDigest",
    "targetSetDigest",
    "baselineDigest",
  ] as const;
  if (record === undefined || !hasExactKeys(record, keys)) {
    return;
  }
  const approvalReference = parseBoundedString(record.approvalReference, {
    max: 512,
    pattern: ID_PATTERN,
  });
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
    approvalReference === undefined ||
    repositoryId === undefined ||
    rootIdentity === undefined ||
    ownerId === undefined ||
    !isDigest(record.requestDigest) ||
    !isDigest(record.targetSetDigest) ||
    !isDigest(record.baselineDigest)
  ) {
    return;
  }
  return {
    approvalReference,
    repositoryId,
    rootIdentity,
    ownerId,
    requestDigest: record.requestDigest,
    targetSetDigest: record.targetSetDigest,
    baselineDigest: record.baselineDigest,
  };
}

function parseJournalTarget(value: unknown): JournalTarget | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, [
      "path",
      "operation",
      "expected",
      "candidate",
      "retiredName",
    ]) ||
    typeof record.path !== "string"
  ) {
    return;
  }
  const expected = parseExpected(record.expected);
  if (expected === undefined) {
    return;
  }
  if (record.operation === "write") {
    const candidate = asRecord(record.candidate);
    if (
      candidate === undefined ||
      !hasExactKeys(candidate, [
        "name",
        "contentDigest",
        "byteLength",
        "identity",
        "deviceId",
      ]) ||
      typeof candidate.name !== "string" ||
      !isDigest(candidate.contentDigest) ||
      !Number.isSafeInteger(candidate.byteLength) ||
      (candidate.byteLength as number) < 0 ||
      (candidate.identity !== null && typeof candidate.identity !== "string") ||
      (candidate.deviceId !== null && typeof candidate.deviceId !== "string") ||
      (candidate.identity === null) !== (candidate.deviceId === null) ||
      record.retiredName !== null
    ) {
      return;
    }
    return {
      path: record.path,
      operation: "write",
      expected,
      candidate: {
        name: candidate.name,
        contentDigest: candidate.contentDigest,
        byteLength: candidate.byteLength as number,
        identity: candidate.identity as string | null,
        deviceId: candidate.deviceId as string | null,
      },
      retiredName: null,
    };
  }
  if (
    record.operation !== "delete" ||
    expected.state !== "file" ||
    record.candidate !== null ||
    typeof record.retiredName !== "string"
  ) {
    return;
  }
  return {
    path: record.path,
    operation: "delete",
    expected,
    candidate: null,
    retiredName: record.retiredName,
  };
}

function parseJournalObject(value: unknown): TransactionJournal | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, [
      "version",
      "transactionId",
      "state",
      "approvalDigest",
      "bindings",
      "targets",
      "journalDigest",
    ]) ||
    record.version !== 1 ||
    !isDigest(record.transactionId) ||
    typeof record.state !== "string" ||
    !JOURNAL_STATES.has(record.state as JournalState) ||
    !isDigest(record.approvalDigest) ||
    !isDigest(record.journalDigest) ||
    !Array.isArray(record.targets) ||
    record.targets.length === 0 ||
    record.targets.length > 256
  ) {
    return;
  }
  const bindings = parseBindings(record.bindings);
  const targets = record.targets.map(parseJournalTarget);
  if (
    bindings === undefined ||
    targets.some((target) => target === undefined)
  ) {
    return;
  }
  const parsedTargets = targets as JournalTarget[];
  const normalizedPaths = parsedTargets.map((target) =>
    normalizeTargetPath(target.path),
  );
  if (
    normalizedPaths.some((path) => path === undefined) ||
    normalizedPaths.some(
      (path, index) => path !== parsedTargets[index]?.path,
    ) ||
    new Set(parsedTargets.map((target) => target.path)).size !==
      parsedTargets.length ||
    parsedTargets.some(
      (target, index) =>
        index > 0 &&
        compareCanonicalText(
          parsedTargets[index - 1]?.path ?? "",
          target.path,
        ) > 0,
    )
  ) {
    return;
  }
  const journal: TransactionJournal = {
    version: 1,
    transactionId: record.transactionId,
    state: record.state as JournalState,
    approvalDigest: record.approvalDigest,
    bindings,
    targets: parsedTargets,
    journalDigest: record.journalDigest,
  };
  if (
    journal.state !== "preparing" &&
    journal.targets.some(
      (target) =>
        target.operation === "write" &&
        (target.candidate === null ||
          target.candidate.identity === null ||
          target.candidate.deviceId === null),
    )
  ) {
    return;
  }
  const { journalDigest, ...payload } = journal;
  const targetDescriptors = journal.targets.map((target) =>
    target.operation === "write" && target.candidate !== null
      ? {
          path: target.path,
          operation: target.operation,
          expected: target.expected,
          candidateDigest: target.candidate.contentDigest,
          candidateByteLength: target.candidate.byteLength,
        }
      : {
          path: target.path,
          operation: target.operation,
          expected: target.expected,
        },
  );
  const targetSetDigest = digestValue(
    journal.targets.map((target) => ({
      path: target.path,
      operation: target.operation,
    })),
  );
  const baselineDigest = digestValue(
    journal.targets.map((target) => ({
      path: target.path,
      expected: target.expected,
    })),
  );
  const requestDigest = digestValue({
    version: 1,
    repositoryId: journal.bindings.repositoryId,
    rootIdentity: journal.bindings.rootIdentity,
    ownerId: journal.bindings.ownerId,
    approvalReference: journal.bindings.approvalReference,
    targets: targetDescriptors,
  });
  const siblingNamesValid = journal.targets.every((target) => {
    const pathDigest = digestText(target.path);
    const role = target.operation === "write" ? "candidate" : "retired";
    const expectedName = `.skizzles-transaction-${journal.transactionId}-${pathDigest}-${role}`;
    return target.operation === "write"
      ? target.candidate?.name === expectedName && target.retiredName === null
      : target.candidate === null && target.retiredName === expectedName;
  });
  return digestPayload(payload) === journalDigest &&
    journal.transactionId ===
      digestValue({
        requestDigest: journal.bindings.requestDigest,
        approvalDigest: journal.approvalDigest,
      }) &&
    journal.bindings.targetSetDigest === targetSetDigest &&
    journal.bindings.baselineDigest === baselineDigest &&
    journal.bindings.requestDigest === requestDigest &&
    siblingNamesValid
    ? journal
    : undefined;
}

export function decodeJournal(bytes: Uint8Array): JournalDecodeResult {
  if (bytes.byteLength === 0 || bytes.byteLength > 1_048_576) {
    return {
      ok: false,
      code: "MALFORMED_JOURNAL",
      message: "journal size is invalid",
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return {
      ok: false,
      code: "MALFORMED_JOURNAL",
      message: "journal is not canonical UTF-8 JSON",
    };
  }
  const journal = parseJournalObject(value);
  if (journal === undefined || !bytesEqual(bytes, encodeJournal(journal))) {
    return {
      ok: false,
      code: "MALFORMED_JOURNAL",
      message: "journal failed schema, digest, or canonical encoding checks",
    };
  }
  return { ok: true, journal };
}
