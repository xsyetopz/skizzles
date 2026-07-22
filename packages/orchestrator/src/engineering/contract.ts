import type { VerificationGateReceipt } from "@skizzles/acceptance";
import type {
  ChangeAssurance,
  ChangeAssuranceReceipt,
  ChangeDeclaration,
  IndependentSecurityReviewAuthority,
  SecurityPolicyLinterAuthority,
  SecurityPolicyLintReceipt,
  SecurityReviewReceipt,
} from "@skizzles/change-assurance";
import type { SourceEngineering } from "@skizzles/source-transformation";
import type { TaskWorktreeVerificationReceipt } from "@skizzles/task-worktree";
import type { NormalizedRequest } from "../admission/intent.ts";
import type { RepositoryContext } from "../admission/repository.ts";
import type {
  CausalWorkflowConfig,
  WorkflowCleanupResult,
  WorkflowFailureCode,
  WorkflowPromotionResult,
  WorkflowRecoveryResult,
  WorkflowRejectionResult,
  WorkflowReview,
} from "../workflow/causal/contract.ts";
import type {
  PhysicalIntegrationAuthorityPort,
  PhysicalIntegrationReceipt,
} from "./physical.ts";
import type {
  TaskContext,
  TaskContextResetResult,
  TaskRuntimeInterruptAuthorityPort,
} from "./reset/contract.ts";
import type {
  ContextBudgetAuthorityPort,
  ContextPause,
} from "./session/context.ts";
import type { EngineeringContinuation } from "./session/continuation.ts";

export type EngineeringObjective = "behavioral" | "format-only";
export type EngineeringDeclarationKind =
  | "class"
  | "enum"
  | "function"
  | "interface"
  | "type";

export interface EngineeringNodeSelector {
  readonly declarationKind: EngineeringDeclarationKind;
  readonly name: string;
  readonly expectedNodeDigest: string;
}

export type EngineeringEditOperation =
  | {
      readonly kind: "replace";
      readonly selector: EngineeringNodeSelector;
      readonly templateId: string;
      readonly nodeSource: string;
    }
  | {
      readonly kind: "insert";
      readonly anchor: EngineeringNodeSelector;
      readonly position: "before" | "after";
      readonly templateId: string;
      readonly nodeSource: string;
    }
  | {
      readonly kind: "delete";
      readonly selector: EngineeringNodeSelector;
    };

export interface EngineeringFaultDeclaration {
  readonly productionPath: string;
  readonly failureCodes: readonly string[];
}

export interface EngineeringNegativeEvidence {
  readonly productionPath: string;
  readonly testPath: string;
}

export interface EngineeringTarget {
  readonly path: string;
  readonly operations: readonly EngineeringEditOperation[];
}

export interface EngineeringContext {
  readonly contextDigest: string;
  readonly templates: readonly {
    readonly templateId: string;
    readonly language: string;
    readonly schemaText: string;
    readonly schemaDigest: string;
    readonly tool: string;
    readonly version: string;
  }[];
  readonly targets: readonly {
    readonly path: string;
    readonly baselineDigest: string;
    readonly baselineSemanticDigest: string;
    readonly declarations: readonly {
      readonly declarationKind: EngineeringDeclarationKind;
      readonly name: string;
      readonly nodeDigest: string;
    }[];
  }[];
}

export interface EngineeringDescribeInput {
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly targets: readonly string[];
  readonly validationProfile: string;
}

export interface EngineeringPrepareInput {
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly context: EngineeringContext;
  readonly changeDeclaration: ChangeDeclaration;
  readonly targets: readonly EngineeringTarget[];
  readonly faultDeclarations: {
    readonly declarations: readonly EngineeringFaultDeclaration[];
    readonly negativeTests: readonly EngineeringNegativeEvidence[];
  };
  readonly validationProfile: string;
  readonly integrations: readonly unknown[];
}

export type SourceEngineeringPort = SourceEngineering;

export interface EngineeringValidationProfile {
  readonly id: string;
  readonly language: string;
  readonly objective: EngineeringObjective;
  readonly formatterId: string;
  readonly commandProfileIds: readonly string[];
  readonly negativeTestCommands: readonly {
    readonly profileId: string;
    readonly testPaths: readonly string[];
  }[];
}

export interface EngineeringWorkflowConfig {
  readonly causal: CausalWorkflowConfig;
  readonly sourceEngineering: SourceEngineeringPort;
  readonly changeAssurance: ChangeAssurance;
  readonly securityPolicyLinter: SecurityPolicyLinterAuthority;
  readonly independentSecurityReview: IndependentSecurityReviewAuthority;
  readonly contextBudget: ContextBudgetAuthorityPort;
  readonly physicalIntegration: PhysicalIntegrationAuthorityPort;
  readonly taskRuntime: TaskRuntimeInterruptAuthorityPort;
  readonly validationProfiles: readonly EngineeringValidationProfile[];
  readonly discoveryRoot: string;
}

export interface EngineeringPreviewTarget {
  readonly path: string;
  readonly candidateDigest: string;
  readonly baselineSemanticDigest: string;
  readonly candidateSemanticDigest: string;
  readonly provenanceDigest: string;
  readonly validationDigest: string;
}

export interface EngineeringPreview {
  readonly evidenceDigest: string;
  readonly candidateDigest: string;
  readonly provenanceDigest: string;
  readonly validationDigest: string;
  readonly observedNegativeTests: readonly Readonly<{
    productionPath: string;
    testPath: string;
    failureCodes: readonly string[];
  }>[];
  readonly targets: readonly EngineeringPreviewTarget[];
  readonly integrations: readonly PhysicalIntegrationReceipt[];
  readonly assurance: ChangeAssuranceReceipt;
  readonly security: Readonly<{
    readonly lintReceipt: SecurityPolicyLintReceipt;
    readonly reviewReceipt: SecurityReviewReceipt;
  }>;
  readonly taskVerificationReceipts: readonly TaskWorktreeVerificationReceipt[];
  readonly verificationGateReceipt: VerificationGateReceipt;
}

export interface EngineeringReview extends WorkflowReview {
  readonly preview: EngineeringPreview;
}

export type EngineeringFailureCode =
  | WorkflowFailureCode
  | "SOURCE_ENGINEERING_REJECTED"
  | "CHANGE_ASSURANCE_REJECTED"
  | "SECURITY_REVIEW_REJECTED"
  | "CONTEXT_BUDGET_REJECTED"
  | "CONTEXT_BUDGET_DRIFTED"
  | "CONTINUATION_REJECTED"
  | "CONTINUATION_DRIFTED"
  | "TASK_CONTEXT_STALE"
  | "INTEGRATION_REJECTED";

export type EngineeringPrepareResult =
  | { readonly status: "awaiting-approval"; readonly review: EngineeringReview }
  | {
      readonly status: "paused";
      readonly code: "CONTEXT_BUDGET_PAUSED";
      readonly continuation: EngineeringContinuation;
      readonly budget: ContextPause;
    }
  | {
      readonly status: "rejected";
      readonly code: EngineeringFailureCode;
      readonly cleanup: null;
    }
  | Exclude<
      Awaited<
        ReturnType<
          import("../workflow/causal/contract.ts").CausalWorkflow["prepare"]
        >
      >,
      { readonly status: "awaiting-approval" }
    >;

export type EngineeringContinuationCancelResult =
  | { readonly status: "cancelled" }
  | {
      readonly status: "rejected";
      readonly code: "INVALID_WORKFLOW_INPUT" | "CONTINUATION_REJECTED";
    };

export type EngineeringDescribeResult =
  | {
      readonly status: "described";
      readonly context: EngineeringContext;
      readonly taskContext: TaskContext;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_WORKFLOW_INPUT"
        | "SOURCE_ENGINEERING_REJECTED"
        | "CONTEXT_BUDGET_REJECTED"
        | "TASK_CONTEXT_STALE";
    };

export interface EngineeringWorkflow {
  readonly describe: (input: unknown) => Promise<EngineeringDescribeResult>;
  readonly prepare: (input: unknown) => Promise<EngineeringPrepareResult>;
  readonly continue: (input: unknown) => Promise<EngineeringPrepareResult>;
  readonly cancelContinuation: (
    input: unknown,
  ) => Promise<EngineeringContinuationCancelResult>;
  readonly approveAndPromote: (
    input: unknown,
  ) => Promise<WorkflowPromotionResult>;
  readonly reject: (input: unknown) => Promise<WorkflowRejectionResult>;
  readonly recover: (input: unknown) => Promise<WorkflowRecoveryResult>;
  readonly retryCleanup: (input: unknown) => Promise<WorkflowCleanupResult>;
  readonly resetContext: (input: unknown) => Promise<TaskContextResetResult>;
  readonly resumeContextReset: (
    input: unknown,
  ) => Promise<TaskContextResetResult>;
}

export type EngineeringWorkflowResult =
  | { readonly status: "accepted"; readonly workflow: EngineeringWorkflow }
  | { readonly status: "rejected"; readonly code: "INVALID_WORKFLOW_CONFIG" };
