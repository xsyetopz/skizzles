export type JournalState =
  | "preparing"
  | "prepared"
  | "publishing"
  | "committed"
  | "cleanup-pending";

export type FileSnapshot = Readonly<{
  state: "file";
  identity: string;
  deviceId: string;
  byteLength: number;
  contentDigest: string;
  linkCount: number;
}>;

export type MissingSnapshot = Readonly<{ state: "missing" }>;

export type UnsafeSnapshot = Readonly<{
  state: "symlink" | "directory" | "other";
  identity: string;
  deviceId: string;
  linkCount: number;
}>;

export type TargetSnapshot = FileSnapshot | MissingSnapshot | UnsafeSnapshot;
export type ExpectedSnapshot = FileSnapshot | MissingSnapshot;

export type RepositoryIdentity = Readonly<{
  repositoryId: string;
  rootIdentity: string;
  deviceId: string;
}>;

export type OwnershipTag = Readonly<{
  transactionId: string;
  targetPath: string;
  role: "candidate" | "retired";
}>;

export type SiblingSnapshot = Readonly<{
  name: string;
  identity: string;
  deviceId: string;
  byteLength: number;
  contentDigest: string;
  linkCount: number;
  kind: "file";
  ownership: OwnershipTag;
}>;

export type JournalSnapshot = Readonly<{
  bytes: Uint8Array;
  identity: string;
  deviceId: string;
  revision: string;
  linkCount: number;
  kind: "file" | "symlink" | "directory" | "other";
}>;

export type DestinationAuthorityPort = Readonly<{
  captureRepository: (repositoryId: string) => Promise<RepositoryIdentity>;
  inspectTargets: (
    repository: RepositoryIdentity,
    paths: readonly string[],
  ) => Promise<readonly TargetSnapshot[]>;
  readJournal: (
    repository: RepositoryIdentity,
  ) => Promise<JournalSnapshot | undefined>;
  writeJournal: (
    repository: RepositoryIdentity,
    expectedRevision: string | undefined,
    bytes: Uint8Array,
  ) => Promise<JournalSnapshot>;
  removeJournal: (
    repository: RepositoryIdentity,
    expectedRevision: string,
  ) => Promise<void>;
  createSibling: (
    repository: RepositoryIdentity,
    name: string,
    bytes: Uint8Array,
    ownership: OwnershipTag,
  ) => Promise<SiblingSnapshot>;
  inspectSibling: (
    repository: RepositoryIdentity,
    name: string,
  ) => Promise<SiblingSnapshot | undefined>;
  removeSibling: (
    repository: RepositoryIdentity,
    sibling: SiblingSnapshot,
    ownership: OwnershipTag,
  ) => Promise<void>;
  replaceTargetFromSibling: (
    repository: RepositoryIdentity,
    targetPath: string,
    expectedTarget: ExpectedSnapshot,
    sibling: SiblingSnapshot,
  ) => Promise<FileSnapshot>;
  retireTargetToSibling: (
    repository: RepositoryIdentity,
    targetPath: string,
    expectedTarget: FileSnapshot,
    siblingName: string,
    ownership: OwnershipTag,
  ) => Promise<SiblingSnapshot>;
}>;

export type ApprovalBindings = Readonly<{
  approvalReference: string;
  repositoryId: string;
  rootIdentity: string;
  ownerId: string;
  requestDigest: string;
  targetSetDigest: string;
  baselineDigest: string;
}>;

export type ApprovalDecision =
  | Readonly<{
      status: "approved";
      approvalDigest: string;
      bindings: ApprovalBindings;
    }>
  | Readonly<{ status: "rejected" | "already-consumed" | "unknown" }>;

export type ApprovalAuthorityPort = Readonly<{
  verifyAndConsume: (bindings: ApprovalBindings) => Promise<ApprovalDecision>;
}>;

export type PublicationLease = Readonly<{
  leaseId: string;
  repositoryId: string;
  rootIdentity: string;
  ownerId: string;
  release: () => Promise<void>;
}>;

export type PublicationLeaseDecision =
  | Readonly<{ status: "acquired"; lease: PublicationLease }>
  | Readonly<{ status: "busy" | "unknown-owner" }>;

export type RepositoryLeaseAuthorityPort = Readonly<{
  acquirePublication: (
    input: Readonly<{
      repositoryId: string;
      rootIdentity: string;
      ownerId: string;
    }>,
  ) => Promise<PublicationLeaseDecision>;
}>;

export type CrashStep =
  | "journal-preparing"
  | "candidate-created"
  | "journal-prepared"
  | "journal-publishing"
  | "target-published"
  | "journal-committed"
  | "journal-cleanup-pending";

export type CrashInjectionPort = Readonly<{
  checkpoint: (
    input: Readonly<{
      step: CrashStep;
      transactionId: string;
      targetPath?: string;
    }>,
  ) => Promise<boolean>;
}>;

export type TransactionFailureCode =
  | "APPROVAL_BINDING_MISMATCH"
  | "APPROVAL_REJECTED"
  | "APPROVAL_REPLAYED"
  | "BUSY"
  | "CLEANUP_FAILED"
  | "CRASH_INJECTED"
  | "CROSS_DEVICE"
  | "DESTINATION_FAILURE"
  | "DUPLICATE_TARGET"
  | "HARDLINK_REJECTED"
  | "JOURNAL_BINDING_MISMATCH"
  | "JOURNAL_CONFLICT"
  | "LEASE_RELEASE_FAILED_BEFORE_COMMIT"
  | "MALFORMED_INPUT"
  | "MALFORMED_JOURNAL"
  | "PATH_ESCAPE"
  | "REPOSITORY_REBOUND"
  | "SYMLINK_REJECTED"
  | "TARGET_DRIFT"
  | "UNKNOWN_OWNER";

export type TransactionEvidence = Readonly<{
  transactionId?: string;
  journalState?: JournalState;
  requestDigest?: string;
  targetPath?: string;
  artifactName?: string;
  leaseId?: string;
  priorCode?: TransactionFailureCode;
  detail?: string;
}>;

export type TransactionFailure = Readonly<{
  ok: false;
  code: TransactionFailureCode;
  message: string;
  evidence?: TransactionEvidence;
}>;

export type PublicationSuccess = Readonly<{
  ok: true;
  status: "committed";
  transactionId: string;
  requestDigest: string;
  targetSetDigest: string;
  baselineDigest: string;
  publishedTargets: number;
}>;

export type CommittedTransactionFailure = Readonly<{
  ok: false;
  code: "COMMITTED_OPERATION_FAILED";
  status: "committed-recovery-required";
  message: string;
  commitmentSource: "publication" | "recovery";
  publicationCommitted: true;
  journalPresent: true;
  recoveryRequired: true;
  journalState: "committed" | "cleanup-pending";
  transactionId: string;
  requestDigest: string;
  targetSetDigest: string;
  baselineDigest: string;
  publishedTargets: number;
  cause: TransactionFailure;
  evidence: TransactionEvidence;
}>;

export type PublicationRecoveryRequiredFailure = Readonly<{
  ok: false;
  code: "PUBLICATION_RECOVERY_REQUIRED";
  status: "partially-published-recovery-required";
  message: string;
  commitmentSource: "publication" | "recovery";
  publicationStarted: true;
  publicationCommitted: false;
  journalPresent: true;
  recoveryRequired: true;
  journalState: "publishing";
  transactionId: string;
  requestDigest: string;
  targetSetDigest: string;
  baselineDigest: string;
  plannedTargets: number;
  verifiedPublishedTargets: number;
  cause: TransactionFailure;
  evidence: TransactionEvidence;
}>;

export type PostPublicationLeaseCleanupFailure = Readonly<{
  ok: false;
  code: "LEASE_RELEASE_FAILED_AFTER_PUBLICATION_STARTED";
  status: "partially-published-recovery-required-lease-cleanup-failed";
  message: string;
  commitmentSource: "publication" | "recovery";
  publicationStarted: true;
  publicationCommitted: false;
  journalPresent: true;
  recoveryRequired: true;
  journalState: "publishing";
  transactionId: string;
  requestDigest: string;
  targetSetDigest: string;
  baselineDigest: string;
  plannedTargets: number;
  verifiedPublishedTargets: number;
  evidence: Readonly<{
    transactionId: string;
    requestDigest: string;
    leaseId: string;
    detail: string;
  }>;
  priorFailure: TransactionFailure;
}>;

export type PostCommitLeaseCleanupFailure = Readonly<{
  ok: false;
  code: "LEASE_RELEASE_FAILED_AFTER_COMMIT";
  message: string;
  commitmentSource: "publication" | "recovery";
  publicationCommitted: true;
  transactionId: string;
  requestDigest: string;
  targetSetDigest: string;
  baselineDigest: string;
  publishedTargets: number;
  evidence: Readonly<{
    transactionId: string;
    requestDigest: string;
    leaseId: string;
    detail: string;
  }>;
  priorFailure?: TransactionFailure;
}> &
  (
    | Readonly<{
        status: "committed-no-recovery-lease-cleanup-failed";
        journalPresent: false;
        recoveryRequired: false;
        journalState: "absent";
      }>
    | Readonly<{
        status: "committed-recovery-required-lease-cleanup-failed";
        journalPresent: true;
        recoveryRequired: true;
        journalState: "committed" | "cleanup-pending";
      }>
  );

export type RecoveryWithoutCommit = Readonly<{
  ok: true;
  status: "no-journal" | "recovered-old";
  transactionId?: string;
  journalState?: JournalState;
}>;

export type RecoveryCommittedSuccess = Readonly<{
  ok: true;
  status: "recovered-new";
  publicationCommitted: true;
  journalPresent: false;
  recoveryRequired: false;
  transactionId: string;
  requestDigest: string;
  targetSetDigest: string;
  baselineDigest: string;
  publishedTargets: number;
  journalState: "committed" | "cleanup-pending";
}>;

export type RecoverySuccess = RecoveryWithoutCommit | RecoveryCommittedSuccess;

export type PublicationResult =
  | PublicationSuccess
  | PublicationRecoveryRequiredFailure
  | CommittedTransactionFailure
  | PostPublicationLeaseCleanupFailure
  | PostCommitLeaseCleanupFailure
  | TransactionFailure;
export type RecoveryResult =
  | RecoverySuccess
  | PublicationRecoveryRequiredFailure
  | CommittedTransactionFailure
  | PostPublicationLeaseCleanupFailure
  | PostCommitLeaseCleanupFailure
  | TransactionFailure;
