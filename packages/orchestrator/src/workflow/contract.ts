import type { CommandObservationReceipt } from "@skizzles/command-supervisor";
import type {
  CloseReport,
  WorkspaceUsageLimits,
} from "@skizzles/run-workspace";
import type {
  CrashInjectionPort,
  DestinationAuthorityPort,
  ExpectedSnapshot,
  PostCommitLeaseCleanupFailure,
  PublicationResult,
  RecoveryResult,
  RepositoryLeaseAuthorityPort,
} from "@skizzles/workspace-transaction";
import type { Orchestrator } from "../runtime.ts";
import type { ApprovalRequest } from "../state/approval.ts";
import type { TargetBaseline } from "../state/target.ts";

export type StderrPolicy = "evidence" | "must-be-empty";
export type TerminalPublication =
  | Extract<PublicationResult, { readonly ok: true }>
  | PostCommitLeaseCleanupFailure;

export interface CommandAuditProfile {
  readonly id: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
  readonly drainMilliseconds: number;
  readonly signalGraceMilliseconds: number;
  readonly allowedExitCodes: readonly number[];
  readonly stderr: StderrPolicy;
}

export interface PublicationIdentity {
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly ownerId: string;
}

export interface PublicationBaselineAuthorityPort {
  capture(input: {
    readonly baseline: TargetBaseline;
    readonly targets: readonly {
      readonly path: string;
      readonly operation: "write" | "delete";
    }[];
  }): unknown | Promise<unknown>;
}

export interface CausalWorkflowConfig {
  readonly orchestrator: Orchestrator;
  readonly publicationIdentity: PublicationIdentity;
  readonly baselineAuthority: PublicationBaselineAuthorityPort;
  readonly transaction: {
    readonly destination: DestinationAuthorityPort;
    readonly leases: RepositoryLeaseAuthorityPort;
    readonly crashInjection?: CrashInjectionPort;
  };
  readonly workspaceUsageLimits: WorkspaceUsageLimits;
  readonly commandProfiles: readonly CommandAuditProfile[];
  readonly approvalContext: {
    readonly taskId: string;
    readonly principalId: string;
    readonly operation: string;
  };
}

export interface WorkflowCommandAudit {
  readonly profileId: string;
  readonly receipt: CommandObservationReceipt;
  readonly stderrEvidence: readonly number[] | null;
}

export interface WorkflowReview {
  readonly workflowId: string;
  readonly approval: ApprovalRequest;
  readonly diffDigest: string;
  readonly commandAudits: readonly WorkflowCommandAudit[];
}

export interface WorkflowCleanupHandle {
  readonly workflowId: string;
}

export interface WorkflowRecoveryHandle {
  readonly workflowId: string;
  readonly recoveryDigest: string;
}

export interface WorkflowCleanupReceipt {
  readonly workflowId: string;
  readonly attempt: number;
  readonly approvalCancelled: boolean;
  readonly workspace: CloseReport | null;
  readonly targetReleased: boolean;
  readonly complete: boolean;
  readonly receiptDigest: string;
}

export type WorkflowFailureCode =
  | "INVALID_WORKFLOW_CONFIG"
  | "INVALID_WORKFLOW_INPUT"
  | "TARGET_BASELINE_REJECTED"
  | "DISCOVERY_INCOMPLETE"
  | "EXECUTION_BUDGET_REJECTED"
  | "WORKSPACE_REJECTED"
  | "WORKSPACE_QUOTA_REJECTED"
  | "COMMAND_PROFILE_REJECTED"
  | "COMMAND_OBSERVATION_REJECTED"
  | "PUBLICATION_BASELINE_REJECTED"
  | "DIFF_REJECTED"
  | "COMPLETION_CONTRACT_REJECTED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_DRIFTED"
  | "APPROVAL_EXPIRED"
  | "PUBLICATION_CLEANUP_FAILED"
  | "PUBLICATION_REJECTED"
  | "PUBLICATION_UNCERTAIN"
  | "RECOVERY_REJECTED"
  | "CLEANUP_FAILED"
  | "WORKFLOW_BUSY"
  | "WORKFLOW_STALE";

export type WorkflowPrepareResult =
  | { readonly status: "awaiting-approval"; readonly review: WorkflowReview }
  | {
      readonly status: "rejected";
      readonly code: WorkflowFailureCode;
      readonly cleanup: WorkflowCleanupReceipt | null;
    }
  | {
      readonly status: "cleanup-pending";
      readonly code: WorkflowFailureCode;
      readonly handle: WorkflowCleanupHandle;
      readonly cleanup: WorkflowCleanupReceipt;
    };

export type WorkflowPromotionResult =
  | {
      readonly status: "completed";
      readonly publication: Extract<PublicationResult, { readonly ok: true }>;
      readonly cleanup: WorkflowCleanupReceipt;
    }
  | {
      readonly status: "rejected";
      readonly code: WorkflowFailureCode;
      readonly cleanup: WorkflowCleanupReceipt | null;
    }
  | {
      readonly status: "cleanup-pending";
      readonly code: WorkflowFailureCode;
      readonly handle: WorkflowCleanupHandle;
      readonly cleanup: WorkflowCleanupReceipt;
    }
  | {
      readonly status: "recovery-required";
      readonly code: "PUBLICATION_UNCERTAIN";
      readonly handle: WorkflowRecoveryHandle;
    }
  | {
      readonly status: "publication-committed-cleanup-failed";
      readonly code: "PUBLICATION_CLEANUP_FAILED";
      readonly publication: PostCommitLeaseCleanupFailure;
      readonly cleanup: WorkflowCleanupReceipt;
    };

export type WorkflowRejectionResult =
  | {
      readonly status: "rejected";
      readonly code: "APPROVAL_REJECTED";
      readonly cleanup: WorkflowCleanupReceipt;
    }
  | {
      readonly status: "cleanup-pending";
      readonly code: "CLEANUP_FAILED";
      readonly handle: WorkflowCleanupHandle;
      readonly cleanup: WorkflowCleanupReceipt;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_WORKFLOW_INPUT"
        | "WORKFLOW_BUSY"
        | "WORKFLOW_STALE";
      readonly cleanup: null;
    };

export type WorkflowCleanupResult =
  | {
      readonly status: "cleaned";
      readonly cleanup: WorkflowCleanupReceipt;
      readonly publication: TerminalPublication | null;
      readonly recovery: Extract<RecoveryResult, { readonly ok: true }> | null;
    }
  | {
      readonly status: "cleanup-pending";
      readonly code: "CLEANUP_FAILED";
      readonly handle: WorkflowCleanupHandle;
      readonly cleanup: WorkflowCleanupReceipt;
    }
  | {
      readonly status: "rejected";
      readonly code: "INVALID_WORKFLOW_INPUT" | "WORKFLOW_STALE";
    };

export type WorkflowRecoveryResult =
  | {
      readonly status: "completed";
      readonly recovery: Extract<RecoveryResult, { readonly ok: true }>;
      readonly cleanup: WorkflowCleanupReceipt;
    }
  | {
      readonly status: "recovered-without-publication";
      readonly recovery: Extract<RecoveryResult, { readonly ok: true }>;
      readonly cleanup: WorkflowCleanupReceipt;
    }
  | {
      readonly status: "recovery-required";
      readonly code: "RECOVERY_REJECTED";
      readonly handle: WorkflowRecoveryHandle;
    }
  | {
      readonly status: "cleanup-pending";
      readonly code: "CLEANUP_FAILED";
      readonly handle: WorkflowCleanupHandle;
      readonly cleanup: WorkflowCleanupReceipt;
    }
  | {
      readonly status: "rejected";
      readonly code: "INVALID_WORKFLOW_INPUT" | "WORKFLOW_STALE";
    };

export interface CausalWorkflow {
  prepare(input: unknown): Promise<WorkflowPrepareResult>;
  approveAndPromote(input: unknown): Promise<WorkflowPromotionResult>;
  reject(input: unknown): Promise<WorkflowRejectionResult>;
  recover(input: unknown): Promise<WorkflowRecoveryResult>;
  retryCleanup(input: unknown): Promise<WorkflowCleanupResult>;
}

export type CausalWorkflowResult =
  | { readonly status: "accepted"; readonly workflow: CausalWorkflow }
  | { readonly status: "rejected"; readonly code: "INVALID_WORKFLOW_CONFIG" };

export interface CapturedPublicationBaseline {
  readonly baselineDigest: string;
  readonly targets: readonly {
    readonly path: string;
    readonly expected: ExpectedSnapshot;
  }[];
}
