import { bytesEqual } from "./codec.ts";
import type {
  ApprovalBindings,
  CrashInjectionPort,
  CrashStep,
  DestinationAuthorityPort,
  ExpectedSnapshot,
  JournalSnapshot,
  OwnershipTag,
  PublicationLease,
  PublicationResult,
  RecoveryResult,
  RepositoryIdentity,
  RepositoryLeaseAuthorityPort,
  SiblingSnapshot,
  TargetSnapshot,
  TransactionFailure,
} from "./contracts.ts";
import {
  encodeJournal,
  type JournalTarget,
  type TransactionJournal,
} from "./journal.ts";

export type WorkspaceTransactionConfig = Readonly<{
  destination: DestinationAuthorityPort;
  approvals: Readonly<{
    verifyAndConsume: (bindings: ApprovalBindings) => Promise<
      | Readonly<{
          status: "approved";
          approvalDigest: string;
          bindings: ApprovalBindings;
        }>
      | Readonly<{ status: "rejected" | "already-consumed" | "unknown" }>
    >;
  }>;
  leases: RepositoryLeaseAuthorityPort;
  crashInjection?: CrashInjectionPort;
}>;

export type WorkspaceTransaction = Readonly<{
  publish: (input: unknown) => Promise<PublicationResult>;
  recover: (input: unknown) => Promise<RecoveryResult>;
}>;

export function failure(
  code: TransactionFailure["code"],
  message: string,
  evidence?: TransactionFailure["evidence"],
): TransactionFailure {
  return evidence === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, evidence };
}

export function isFailure(value: unknown): value is TransactionFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === false
  );
}

export function exactRepository(
  value: RepositoryIdentity,
  expectedRoot: string,
  expectedRepository: string,
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    value.repositoryId === expectedRepository &&
    value.rootIdentity === expectedRoot &&
    typeof value.deviceId === "string" &&
    value.deviceId.length > 0
  );
}

function snapshotsEqual(
  left: ExpectedSnapshot,
  right: TargetSnapshot,
): boolean {
  if (left.state !== right.state) {
    return false;
  }
  if (left.state === "missing") {
    return true;
  }
  if (right.state !== "file") {
    return false;
  }
  return (
    left.identity === right.identity &&
    left.deviceId === right.deviceId &&
    left.byteLength === right.byteLength &&
    left.contentDigest === right.contentDigest &&
    left.linkCount === right.linkCount
  );
}

function validateTargetSnapshot(
  snapshot: TargetSnapshot,
  expected: ExpectedSnapshot,
  repository: RepositoryIdentity,
  targetPath: string,
): TransactionFailure | undefined {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    typeof snapshot.state !== "string"
  ) {
    return failure(
      "DESTINATION_FAILURE",
      "destination returned a malformed target snapshot",
      { targetPath },
    );
  }
  if (snapshot.state === "symlink") {
    return failure(
      "SYMLINK_REJECTED",
      "symbolic-link targets are not publishable",
      { targetPath },
    );
  }
  if (snapshot.state === "directory" || snapshot.state === "other") {
    return failure("TARGET_DRIFT", "target is not a regular file", {
      targetPath,
    });
  }
  if (snapshot.state === "file") {
    if (snapshot.linkCount !== 1) {
      return failure(
        "HARDLINK_REJECTED",
        "multiply-linked targets are not publishable",
        { targetPath },
      );
    }
    if (snapshot.deviceId !== repository.deviceId) {
      return failure(
        "CROSS_DEVICE",
        "target is outside the repository device",
        { targetPath },
      );
    }
  }
  return snapshotsEqual(expected, snapshot)
    ? undefined
    : failure(
        "TARGET_DRIFT",
        "target no longer matches its approved baseline",
        { targetPath },
      );
}

export function validateAllTargets(
  snapshots: readonly TargetSnapshot[],
  targets: readonly Readonly<{ path: string; expected: ExpectedSnapshot }>[],
  repository: RepositoryIdentity,
): TransactionFailure | undefined {
  if (!Array.isArray(snapshots) || snapshots.length !== targets.length) {
    return failure(
      "DESTINATION_FAILURE",
      "destination returned an incomplete target snapshot set",
    );
  }
  for (const [index, target] of targets.entries()) {
    const snapshot = snapshots[index];
    if (snapshot === undefined) {
      return failure(
        "DESTINATION_FAILURE",
        "destination omitted a target snapshot",
        { targetPath: target.path },
      );
    }
    const invalid = validateTargetSnapshot(
      snapshot,
      target.expected,
      repository,
      target.path,
    );
    if (invalid !== undefined) {
      return invalid;
    }
  }
  return undefined;
}

export function validateJournalSnapshot(
  snapshot: JournalSnapshot,
  expectedBytes: Uint8Array | undefined,
  repository: RepositoryIdentity,
): TransactionFailure | undefined {
  if (snapshot.kind !== "file") {
    return failure(
      "SYMLINK_REJECTED",
      "transaction journal is not a regular file",
    );
  }
  if (snapshot.linkCount !== 1) {
    return failure(
      "HARDLINK_REJECTED",
      "transaction journal has multiple links",
    );
  }
  if (snapshot.deviceId !== repository.deviceId) {
    return failure(
      "CROSS_DEVICE",
      "transaction journal is outside the repository device",
    );
  }
  if (
    !(snapshot.bytes instanceof Uint8Array) ||
    typeof snapshot.identity !== "string" ||
    typeof snapshot.revision !== "string" ||
    (expectedBytes !== undefined && !bytesEqual(snapshot.bytes, expectedBytes))
  ) {
    return failure(
      "DESTINATION_FAILURE",
      "destination returned a malformed journal snapshot",
    );
  }
  return undefined;
}

export function expectedOwnership(
  journal: TransactionJournal,
  target: JournalTarget,
): OwnershipTag {
  return {
    transactionId: journal.transactionId,
    targetPath: target.path,
    role: target.operation === "write" ? "candidate" : "retired",
  };
}

export function validateSibling(
  sibling: SiblingSnapshot,
  name: string,
  ownership: OwnershipTag,
  repository: RepositoryIdentity,
  expected: Readonly<{
    contentDigest: string;
    byteLength: number;
    identity?: string;
  }>,
): TransactionFailure | undefined {
  if (
    sibling.kind !== "file" ||
    sibling.name !== name ||
    sibling.linkCount !== 1 ||
    sibling.deviceId !== repository.deviceId
  ) {
    const code =
      sibling.deviceId === repository.deviceId
        ? "HARDLINK_REJECTED"
        : "CROSS_DEVICE";
    return failure(
      code,
      "owned sibling failed file, link, or device validation",
      { artifactName: name },
    );
  }
  if (
    sibling.ownership.transactionId !== ownership.transactionId ||
    sibling.ownership.targetPath !== ownership.targetPath ||
    sibling.ownership.role !== ownership.role ||
    sibling.contentDigest !== expected.contentDigest ||
    sibling.byteLength !== expected.byteLength ||
    (expected.identity !== undefined && sibling.identity !== expected.identity)
  ) {
    return failure(
      "TARGET_DRIFT",
      "owned sibling identity or content changed",
      {
        targetPath: ownership.targetPath,
        artifactName: name,
      },
    );
  }
  return undefined;
}

export function bindingsEqual(
  left: ApprovalBindings,
  right: ApprovalBindings,
): boolean {
  return (
    left.approvalReference === right.approvalReference &&
    left.repositoryId === right.repositoryId &&
    left.rootIdentity === right.rootIdentity &&
    left.ownerId === right.ownerId &&
    left.requestDigest === right.requestDigest &&
    left.targetSetDigest === right.targetSetDigest &&
    left.baselineDigest === right.baselineDigest
  );
}

export async function checkpoint(
  port: CrashInjectionPort | undefined,
  step: CrashStep,
  transactionId: string,
  targetPath?: string,
): Promise<TransactionFailure | undefined> {
  if (port === undefined) {
    return;
  }
  const injected = await port.checkpoint(
    targetPath === undefined
      ? { step, transactionId }
      : { step, transactionId, targetPath },
  );
  if (!injected) {
    return;
  }
  return targetPath === undefined
    ? failure("CRASH_INJECTED", `crash injected at ${step}`, { transactionId })
    : failure("CRASH_INJECTED", `crash injected at ${step}`, {
        transactionId,
        targetPath,
      });
}

export async function acquireLease(
  authority: RepositoryLeaseAuthorityPort,
  repositoryId: string,
  rootIdentity: string,
  ownerId: string,
): Promise<PublicationLease | TransactionFailure> {
  const decision = await authority.acquirePublication({
    repositoryId,
    rootIdentity,
    ownerId,
  });
  if (decision.status === "busy") {
    return failure(
      "BUSY",
      "repository publication or indexing lease is already held",
    );
  }
  if (decision.status === "unknown-owner") {
    return failure(
      "UNKNOWN_OWNER",
      "lease owner is not registered for this repository",
    );
  }
  if (
    decision.status !== "acquired" ||
    decision.lease.repositoryId !== repositoryId ||
    decision.lease.rootIdentity !== rootIdentity ||
    decision.lease.ownerId !== ownerId ||
    typeof decision.lease.leaseId !== "string"
  ) {
    return failure(
      "DESTINATION_FAILURE",
      "lease authority returned a malformed or rebound lease",
    );
  }
  return decision.lease;
}

export async function writeJournal(
  destination: DestinationAuthorityPort,
  repository: RepositoryIdentity,
  journal: TransactionJournal,
  previous: JournalSnapshot | undefined,
): Promise<JournalSnapshot | TransactionFailure> {
  const bytes = encodeJournal(journal);
  const snapshot = await destination.writeJournal(
    repository,
    previous?.revision,
    bytes,
  );
  const invalid = validateJournalSnapshot(snapshot, bytes, repository);
  return invalid ?? snapshot;
}

export async function publishOne(
  destination: DestinationAuthorityPort,
  repository: RepositoryIdentity,
  journal: TransactionJournal,
  target: JournalTarget,
): Promise<TransactionFailure | undefined> {
  const [current] = await destination.inspectTargets(repository, [target.path]);
  if (current === undefined) {
    return failure(
      "DESTINATION_FAILURE",
      "destination omitted a publication target",
      { targetPath: target.path },
    );
  }
  if (target.operation === "write") {
    const candidate = target.candidate;
    if (candidate === null) {
      return failure("MALFORMED_JOURNAL", "write target has no candidate", {
        targetPath: target.path,
      });
    }
    if (
      current.state === "file" &&
      candidate.identity !== null &&
      candidate.deviceId !== null &&
      current.identity === candidate.identity &&
      current.contentDigest === candidate.contentDigest &&
      current.byteLength === candidate.byteLength &&
      current.deviceId === candidate.deviceId &&
      current.deviceId === repository.deviceId &&
      current.linkCount === 1
    ) {
      return;
    }
    const baselineFailure = validateTargetSnapshot(
      current,
      target.expected,
      repository,
      target.path,
    );
    if (baselineFailure !== undefined) {
      return baselineFailure;
    }
    const sibling = await destination.inspectSibling(
      repository,
      candidate.name,
    );
    if (sibling === undefined) {
      return failure("TARGET_DRIFT", "candidate sibling is missing", {
        targetPath: target.path,
        artifactName: candidate.name,
      });
    }
    const ownership = expectedOwnership(journal, target);
    if (
      candidate.identity === null ||
      candidate.deviceId === null ||
      candidate.deviceId !== repository.deviceId
    ) {
      return failure(
        "MALFORMED_JOURNAL",
        "prepared candidate identity is missing or cross-device",
        {
          targetPath: target.path,
        },
      );
    }
    const invalidSibling = validateSibling(
      sibling,
      candidate.name,
      ownership,
      repository,
      {
        contentDigest: candidate.contentDigest,
        byteLength: candidate.byteLength,
        identity: candidate.identity,
      },
    );
    if (invalidSibling !== undefined) {
      return invalidSibling;
    }
    const published = await destination.replaceTargetFromSibling(
      repository,
      target.path,
      target.expected,
      sibling,
    );
    if (
      published.state !== "file" ||
      published.identity !== candidate.identity ||
      published.deviceId !== repository.deviceId ||
      published.contentDigest !== candidate.contentDigest ||
      published.byteLength !== candidate.byteLength ||
      published.linkCount !== 1
    ) {
      return failure(
        "DESTINATION_FAILURE",
        "destination did not atomically publish the candidate",
        {
          targetPath: target.path,
        },
      );
    }
    return;
  }
  if (current.state === "missing") {
    return;
  }
  const baselineFailure = validateTargetSnapshot(
    current,
    target.expected,
    repository,
    target.path,
  );
  if (baselineFailure !== undefined) {
    return baselineFailure;
  }
  if (current.state !== "file" || target.retiredName === null) {
    return failure("MALFORMED_JOURNAL", "delete target cannot be retired", {
      targetPath: target.path,
    });
  }
  const existingSibling = await destination.inspectSibling(
    repository,
    target.retiredName,
  );
  if (existingSibling !== undefined) {
    return failure(
      "JOURNAL_CONFLICT",
      "retired sibling name is already occupied",
      {
        targetPath: target.path,
        artifactName: target.retiredName,
      },
    );
  }
  const ownership = expectedOwnership(journal, target);
  const retired = await destination.retireTargetToSibling(
    repository,
    target.path,
    current,
    target.retiredName,
    ownership,
  );
  return validateSibling(retired, target.retiredName, ownership, repository, {
    contentDigest: current.contentDigest,
    byteLength: current.byteLength,
    identity: current.identity,
  });
}

export async function cleanupOwnedSiblings(
  destination: DestinationAuthorityPort,
  repository: RepositoryIdentity,
  journal: TransactionJournal,
): Promise<TransactionFailure | undefined> {
  for (const target of journal.targets) {
    const ownership = expectedOwnership(journal, target);
    const name =
      target.operation === "write"
        ? target.candidate?.name
        : target.retiredName;
    if (name === null || name === undefined) {
      return failure(
        "MALFORMED_JOURNAL",
        "journal does not name its owned sibling",
        { targetPath: target.path },
      );
    }
    const sibling = await destination.inspectSibling(repository, name);
    if (sibling === undefined) {
      continue;
    }
    const expected =
      target.operation === "write"
        ? target.candidate === null
          ? null
          : target.candidate.identity === null
            ? {
                contentDigest: target.candidate.contentDigest,
                byteLength: target.candidate.byteLength,
              }
            : {
                contentDigest: target.candidate.contentDigest,
                byteLength: target.candidate.byteLength,
                identity: target.candidate.identity,
              }
        : target.expected.state === "file"
          ? {
              contentDigest: target.expected.contentDigest,
              byteLength: target.expected.byteLength,
              identity: target.expected.identity,
            }
          : null;
    if (expected === null) {
      return failure("MALFORMED_JOURNAL", "cleanup evidence is incomplete", {
        targetPath: target.path,
      });
    }
    const invalid = validateSibling(
      sibling,
      name,
      ownership,
      repository,
      expected,
    );
    if (invalid !== undefined) {
      return failure(
        "CLEANUP_FAILED",
        "foreign or rebound sibling was preserved",
        {
          transactionId: journal.transactionId,
          targetPath: target.path,
          artifactName: name,
          detail: invalid.code,
        },
      );
    }
    try {
      await destination.removeSibling(repository, sibling, ownership);
    } catch (error) {
      return failure("CLEANUP_FAILED", "owned sibling cleanup failed", {
        transactionId: journal.transactionId,
        targetPath: target.path,
        artifactName: name,
        detail:
          error instanceof Error ? error.message : "unknown cleanup failure",
      });
    }
  }
  return undefined;
}
