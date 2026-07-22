import {
  isTaskWorktreeReceipt,
  isTaskWorktreeVerificationReceipt,
  type TaskWorktreeApprovalAuthorityRequest,
  type TaskWorktreeReceipt,
  type TaskWorktreeVerificationReceipt,
} from "@skizzles/task-worktree";
import {
  type ApprovalRequest,
  isApprovalRequest,
  isPromotionPermit,
  type PromotionPermit,
} from "../../state/approval.ts";

interface ApprovalRecord {
  readonly approval: ApprovalRequest;
  readonly receipt: TaskWorktreeReceipt;
  readonly profileIds: readonly string[];
  readonly verificationReceipts: readonly TaskWorktreeVerificationReceipt[];
  readonly repositoryId: string;
  readonly rootIdentity: string;
}

export interface TaskWorktreeApprovalRegistration {
  readonly schema: "skizzles.orchestrator/task-worktree-approval-registration";
}

interface RegistrationState {
  readonly bridge: TaskWorktreeApprovalBridge;
  readonly key: string;
  active: boolean;
}

const bridges = new WeakSet<object>();
const registrations = new WeakMap<object, RegistrationState>();

export class TaskWorktreeApprovalBridge {
  readonly authorityId: string;
  private readonly records = new Map<string, ApprovalRecord>();

  constructor(authorityId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(authorityId)) {
      throw new TypeError("invalid task-worktree approval authority id");
    }
    this.authorityId = authorityId;
    bridges.add(this);
  }

  register(
    input: Readonly<{
      approval: ApprovalRequest;
      receipt: TaskWorktreeReceipt;
      profileIds: readonly string[];
      verificationReceipts: readonly TaskWorktreeVerificationReceipt[];
      repositoryId: string;
      rootIdentity: string;
    }>,
  ): TaskWorktreeApprovalRegistration | undefined {
    if (
      !(
        isApprovalRequest(input.approval) &&
        isTaskWorktreeReceipt(input.receipt)
      ) ||
      input.approval.challenge === null ||
      input.approval.taskId !== input.receipt.taskId ||
      !validProfiles(input.profileIds) ||
      !validVerificationReceipts(input.verificationReceipts, input.receipt)
    ) {
      return;
    }
    const key = recordKey(
      input.repositoryId,
      input.rootIdentity,
      input.approval.taskId,
      input.approval.approvalId,
    );
    if (this.records.has(key)) return;
    this.records.set(
      key,
      Object.freeze({
        approval: input.approval,
        receipt: input.receipt,
        profileIds: Object.freeze([...input.profileIds]),
        verificationReceipts: Object.freeze([...input.verificationReceipts]),
        repositoryId: input.repositoryId,
        rootIdentity: input.rootIdentity,
      }),
    );
    const registration: TaskWorktreeApprovalRegistration = Object.freeze({
      schema:
        "skizzles.orchestrator/task-worktree-approval-registration" as const,
    });
    registrations.set(registration, { bridge: this, key, active: true });
    return registration;
  }

  unregister(registration: TaskWorktreeApprovalRegistration): boolean {
    const state = registrations.get(registration);
    if (state === undefined || state.bridge !== this) return false;
    if (!state.active) return true;
    this.records.delete(state.key);
    state.active = false;
    return true;
  }

  authorize = async (
    request: TaskWorktreeApprovalAuthorityRequest,
  ): Promise<unknown> => {
    const permit = request.approvalEvidence;
    const binding = request.binding;
    if (!isPromotionPermit(permit)) {
      return Object.freeze({ status: "rejected" });
    }
    const key = recordKey(
      binding.repositoryId,
      binding.rootIdentity,
      binding.taskId,
      permit.approvalId,
    );
    const record = this.records.get(key);
    if (
      request.authorityId !== this.authorityId ||
      record === undefined ||
      !sameApproval(record.approval, permit) ||
      binding.authorityId !== record.receipt.authorityId ||
      binding.repositoryId !== record.repositoryId ||
      binding.rootIdentity !== record.rootIdentity ||
      binding.taskId !== record.receipt.taskId ||
      binding.taskEpochDigest !== record.receipt.taskEpochDigest ||
      binding.requestDigest !== permit.requestDigest ||
      binding.treeDigest !== permit.treeDigest ||
      binding.baselineDigest !== permit.baselineDigest ||
      binding.candidateDigest !== record.receipt.candidateDigest ||
      binding.candidateManifestDigest !==
        record.receipt.candidateManifestDigest ||
      binding.diffDigest !== record.receipt.diff.digest ||
      binding.commitPlanDigest !== record.receipt.commitPlan.planDigest ||
      binding.runReceiptDigest !== record.receipt.receiptDigest ||
      !exactProfiles(binding.runProfileIds, record.profileIds) ||
      !exactVerificationBinding(
        binding.verificationProfileIds,
        binding.verificationReceiptDigests,
        record.verificationReceipts,
      )
    ) {
      return Object.freeze({ status: "rejected" });
    }
    this.records.delete(key);
    return Object.freeze({
      status: "approved" as const,
      bindingDigest: binding.bindingDigest,
      approvalDigest: permit.permitDigest,
    });
  };
}

function exactVerificationBinding(
  profileIds: readonly string[],
  receiptDigests: readonly string[],
  receipts: readonly TaskWorktreeVerificationReceipt[],
): boolean {
  if (
    profileIds.length !== receipts.length ||
    receiptDigests.length !== receipts.length
  ) {
    return false;
  }
  const expected = new Map(
    profileIds.map((profileId, index) => [profileId, receiptDigests[index]]),
  );
  return (
    expected.size === receipts.length &&
    receipts.every(
      ({ profileId, receiptDigest }) =>
        expected.get(profileId) === receiptDigest,
    )
  );
}

function validVerificationReceipts(
  receipts: readonly TaskWorktreeVerificationReceipt[],
  taskReceipt: TaskWorktreeReceipt,
): boolean {
  return (
    Object.isFrozen(receipts) &&
    receipts.length === 4 &&
    receipts.every(
      (receipt) =>
        isTaskWorktreeVerificationReceipt(receipt) &&
        receipt.authorityId === taskReceipt.authorityId &&
        receipt.taskId === taskReceipt.taskId &&
        receipt.taskEpochDigest === taskReceipt.taskEpochDigest &&
        receipt.candidateDigest === taskReceipt.candidateDigest &&
        receipt.candidateManifestDigest ===
          taskReceipt.candidateManifestDigest &&
        receipt.baselineTestManifestDigest ===
          taskReceipt.baselineTestManifestDigest &&
        receipt.candidateTestManifestDigest ===
          taskReceipt.candidateTestManifestDigest &&
        receipt.specificationLockDigest === taskReceipt.specificationLockDigest,
    ) &&
    new Set(receipts.map(({ profileId }) => profileId)).size ===
      receipts.length &&
    new Set(receipts.map(({ receiptDigest }) => receiptDigest)).size ===
      receipts.length
  );
}

function recordKey(
  repositoryId: string,
  rootIdentity: string,
  taskId: string,
  approvalId: string,
): string {
  return `${repositoryId}\0${rootIdentity}\0${taskId}\0${approvalId}`;
}

function validProfiles(input: readonly string[]): boolean {
  return (
    Object.isFrozen(input) &&
    input.every((value) => typeof value === "string") &&
    new Set(input).size === input.length
  );
}

export function isTaskWorktreeApprovalBridge(
  input: unknown,
): input is TaskWorktreeApprovalBridge {
  return typeof input === "object" && input !== null && bridges.has(input);
}

function sameApproval(
  approval: ApprovalRequest,
  permit: PromotionPermit,
): boolean {
  return (
    permit.approvalId === approval.approvalId &&
    permit.challengeDigest === approval.challenge?.challengeDigest &&
    permit.taskId === approval.taskId &&
    permit.principalId === approval.principalId &&
    permit.operation === approval.operation &&
    permit.requestDigest === approval.requestDigest &&
    permit.treeDigest === approval.treeDigest &&
    permit.baselineDigest === approval.baselineDigest &&
    permit.transactionDigest === approval.transactionDigest &&
    permit.discoveryDigest === approval.discoveryDigest &&
    permit.diffDigest === approval.diffDigest
  );
}

function exactProfiles(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    Object.isFrozen(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
