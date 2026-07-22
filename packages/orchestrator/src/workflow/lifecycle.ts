import type { RunWorkspace } from "@skizzles/run-workspace";
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
  private workspace: RunWorkspace | undefined;
  private approval: ApprovalRequest | undefined;
  private approvalTerminal = true;
  private workspaceDone = false;
  private workspaceReport: WorkflowCleanupReceipt["workspace"] = null;
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

  ownWorkspace(workspace: RunWorkspace): void {
    if (this.workspace !== undefined) {
      throw new Error("workflow already owns a run workspace");
    }
    this.workspace = workspace;
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
      !this.workspaceDone &&
      this.workspace !== undefined
    ) {
      this.workspaceReport = await this.workspace.close().catch(() => null);
      this.workspaceDone = this.workspaceReport?.state === "deleted";
    } else if (this.workspace === undefined) {
      this.workspaceDone = true;
    }

    if (this.approvalTerminal && this.workspaceDone && !this.targetDone) {
      const release = this.orchestrator.releaseTargetBaseline(this.baseline);
      this.targetDone = release.status === "released";
    }

    const complete =
      this.approvalTerminal && this.workspaceDone && this.targetDone;
    const material = {
      workflowId: this.handle.workflowId,
      attempt: this.attempt,
      approvalCancelled: this.approvalTerminal,
      workspaceState: this.workspaceReport?.state ?? "none",
      workspaceRunId: this.workspaceReport?.runId ?? "none",
      targetReleased: this.targetDone,
      complete,
    };
    const receipt: WorkflowCleanupReceipt = Object.freeze({
      workflowId: this.handle.workflowId,
      attempt: this.attempt,
      approvalCancelled: this.approvalTerminal,
      workspace: this.workspaceReport,
      targetReleased: this.targetDone,
      complete,
      receiptDigest: digestValue(material),
    });
    receipts.add(receipt);
    return receipt;
  }
}
