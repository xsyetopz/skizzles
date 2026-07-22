import type {
  ApprovalBindings,
  ApprovalDecision,
} from "@skizzles/workspace-publication";
import type { PromotionPermit } from "../../state/approval.ts";
import type { PublicationIdentity } from "../causal/contract.ts";

const rawDigest = /^[0-9a-f]{64}$/u;

interface ActivePermit {
  readonly permit: PromotionPermit;
  readonly identity: PublicationIdentity;
  consumed: boolean;
}

export interface TransactionApprovalReceipt {
  readonly reference: string;
  readonly approvalDigest: string;
  readonly bindings: ApprovalBindings;
}

export class TransactionApprovalBridge {
  private readonly permits = new Map<string, ActivePermit>();
  private readonly receipts = new Map<string, TransactionApprovalReceipt>();

  activate(
    reference: string,
    permit: PromotionPermit,
    identity: PublicationIdentity,
  ): void {
    if (this.permits.has(reference)) {
      throw new Error("transaction approval reference already activated");
    }
    this.permits.set(reference, { permit, identity, consumed: false });
  }

  deactivate(reference: string): void {
    this.permits.delete(reference);
  }

  takeReceipt(reference: string): TransactionApprovalReceipt | undefined {
    const receipt = this.receipts.get(reference);
    this.receipts.delete(reference);
    return receipt;
  }

  verifyAndConsume(bindings: ApprovalBindings): Promise<ApprovalDecision> {
    const active = this.permits.get(bindings.approvalReference);
    if (active === undefined) return Promise.resolve({ status: "unknown" });
    if (active.consumed) return Promise.resolve({ status: "already-consumed" });
    if (
      bindings.repositoryId !== active.identity.repositoryId ||
      bindings.rootIdentity !== active.identity.rootIdentity ||
      bindings.ownerId !== active.identity.ownerId ||
      !rawDigest.test(bindings.requestDigest) ||
      !rawDigest.test(bindings.targetSetDigest) ||
      !rawDigest.test(bindings.baselineDigest)
    ) {
      return Promise.resolve({ status: "rejected" });
    }
    const approvalDigest = active.permit.permitDigest.replace(/^sha256:/u, "");
    if (!rawDigest.test(approvalDigest)) {
      return Promise.resolve({ status: "rejected" });
    }
    active.consumed = true;
    const receipt = Object.freeze({
      reference: bindings.approvalReference,
      approvalDigest,
      bindings: Object.freeze({ ...bindings }),
    });
    this.receipts.set(bindings.approvalReference, receipt);
    return Promise.resolve({
      status: "approved",
      approvalDigest,
      bindings,
    });
  }
}
