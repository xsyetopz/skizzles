import {
  isTaskWorktreeReceipt,
  type TaskWorktree,
  type TaskWorktreeCleanupHandle,
  type TaskWorktreeReceipt,
  type TaskWorktreeSession,
} from "@skizzles/task-worktree";
import { digestValue } from "../digest.ts";
import type { Orchestrator } from "../runtime.ts";
import type { ApprovalRequest } from "../state/approval.ts";
import type { TargetBaseline } from "../state/target.ts";
import type {
  WorkflowCleanupHandle,
  WorkflowCleanupReceipt,
} from "./contract.ts";

const handles = new WeakSet<object>();
const receipts = new WeakSet<object>();

export function isWorkflowCleanupHandle(
  value: unknown,
): value is WorkflowCleanupHandle {
  return typeof value === "object" && value !== null && handles.has(value);
}

export function isWorkflowCleanupReceipt(
  value: unknown,
): value is WorkflowCleanupReceipt {
  return typeof value === "object" && value !== null && receipts.has(value);
}

export class WorkflowLifecycle {
  readonly handle: WorkflowCleanupHandle;
  private readonly orchestrator: Orchestrator;
  private readonly baseline: TargetBaseline;
  private taskWorktree:
    | Readonly<{
        kind: "session";
        authority: TaskWorktree;
        session: TaskWorktreeSession;
      }>
    | Readonly<{
        kind: "cleanup";
        authority: TaskWorktree;
        handle: TaskWorktreeCleanupHandle;
      }>
    | undefined;
  private approval: ApprovalRequest | undefined;
  private approvalTerminal = true;
  private taskWorktreeDone = false;
  private taskWorktreeReceipt: TaskWorktreeReceipt | null = null;
  private taskWorktreeCleanup: WorkflowCleanupReceipt["taskWorktreeCleanup"] =
    "none";
  private targetDone = false;
  private attempt = 0;
  private closePromise: Promise<WorkflowCleanupReceipt> | undefined;
  private finalReceipt: WorkflowCleanupReceipt | undefined;

  constructor(
    workflowId: string,
    orchestrator: Orchestrator,
    baseline: TargetBaseline,
  ) {
    this.orchestrator = orchestrator;
    this.baseline = baseline;
    this.handle = Object.freeze({ workflowId });
    handles.add(this.handle);
  }

  ownTaskWorktree(authority: TaskWorktree, session: TaskWorktreeSession): void {
    if (this.taskWorktree !== undefined) {
      throw new Error("workflow already owns a task worktree session");
    }
    this.taskWorktree = Object.freeze({
      kind: "session" as const,
      authority,
      session,
    });
    this.taskWorktreeCleanup = "pending";
  }

  ownTaskWorktreeCleanup(
    authority: TaskWorktree,
    handle: TaskWorktreeCleanupHandle,
  ): void {
    if (this.taskWorktree !== undefined) {
      throw new Error("workflow already owns task worktree cleanup");
    }
    this.taskWorktree = Object.freeze({
      kind: "cleanup" as const,
      authority,
      handle,
    });
    this.taskWorktreeCleanup = "pending";
  }

  ownApproval(approval: ApprovalRequest): void {
    if (this.approval !== undefined) {
      throw new Error("workflow already owns an approval");
    }
    this.approval = approval;
    this.approvalTerminal = false;
  }

  updateApproval(approval: ApprovalRequest): void {
    if (
      this.approval === undefined ||
      this.approval.approvalId !== approval.approvalId
    ) {
      throw new Error("workflow cannot replace approval ownership");
    }
    this.approval = approval;
  }

  markApprovalTerminal(): void {
    this.approvalTerminal = true;
  }

  close(): Promise<WorkflowCleanupReceipt> {
    if (this.finalReceipt !== undefined)
      return Promise.resolve(this.finalReceipt);
    if (this.closePromise !== undefined) return this.closePromise;
    const active = this.performClose();
    this.closePromise = active;
    active
      .then((receipt) => {
        if (receipt.complete) this.finalReceipt = receipt;
        this.closePromise = undefined;
      })
      .catch(() => {
        this.closePromise = undefined;
      });
    return active;
  }

  private async performClose(): Promise<WorkflowCleanupReceipt> {
    this.attempt += 1;
    if (!this.approvalTerminal && this.approval !== undefined) {
      const cancellation = this.orchestrator.cancelApproval({
        approval: this.approval,
      });
      if (
        cancellation.status === "cancelled" ||
        (cancellation.status === "rejected" &&
          cancellation.code === "APPROVAL_CANCELLED")
      ) {
        this.approvalTerminal = true;
      }
    }

    if (
      this.approvalTerminal &&
      !this.taskWorktreeDone &&
      this.taskWorktree !== undefined
    ) {
      if (this.taskWorktree.kind === "session") {
        const closed = await this.taskWorktree.authority
          .close(
            Object.freeze({
              version: 1 as const,
              session: this.taskWorktree.session,
            }),
          )
          .catch(() => undefined);
        if (
          closed?.status === "closed" &&
          isTaskWorktreeReceipt(closed.receipt)
        ) {
          this.taskWorktreeReceipt = closed.receipt;
          this.taskWorktreeCleanup = "session-closed";
          this.taskWorktreeDone = true;
        }
      } else {
        const cleaned = await this.taskWorktree.authority
          .retryCleanup(
            Object.freeze({
              version: 1 as const,
              handle: this.taskWorktree.handle,
            }),
          )
          .catch(() => undefined);
        if (cleaned?.status === "cleaned") {
          this.taskWorktreeCleanup = "prepare-cleaned";
          this.taskWorktreeDone = true;
        }
      }
    } else if (this.taskWorktree === undefined) {
      this.taskWorktreeDone = true;
    }

    if (this.approvalTerminal && this.taskWorktreeDone && !this.targetDone) {
      const release = this.orchestrator.releaseTargetBaseline(this.baseline);
      this.targetDone = release.status === "released";
    }

    const complete =
      this.approvalTerminal && this.taskWorktreeDone && this.targetDone;
    const material = {
      workflowId: this.handle.workflowId,
      attempt: this.attempt,
      approvalCancelled: this.approvalTerminal,
      taskWorktreeReceiptDigest:
        this.taskWorktreeReceipt?.receiptDigest ?? "none",
      taskWorktreeCleanup: this.taskWorktreeCleanup,
      targetReleased: this.targetDone,
      complete,
    };
    const receipt: WorkflowCleanupReceipt = Object.freeze({
      workflowId: this.handle.workflowId,
      attempt: this.attempt,
      approvalCancelled: this.approvalTerminal,
      taskWorktree: this.taskWorktreeReceipt,
      taskWorktreeCleanup: this.taskWorktreeCleanup,
      targetReleased: this.targetDone,
      complete,
      receiptDigest: digestValue(material),
    });
    receipts.add(receipt);
    return receipt;
  }
}
