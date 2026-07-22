import type {
  ChangeAssurance,
  ChangeAssuranceReceipt,
  ChangeDeclaration,
} from "@skizzles/change-assurance";
import type { SourceEngineering } from "@skizzles/source-engineering";
import type { NormalizedRequest } from "../intent.ts";
import type { RepositoryContext } from "../repository.ts";
import type {
  CausalWorkflowConfig,
  WorkflowCleanupResult,
  WorkflowFailureCode,
  WorkflowPromotionResult,
  WorkflowRecoveryResult,
  WorkflowRejectionResult,
  WorkflowReview,
} from "../workflow/contract.ts";
import type { ContextBudgetAuthorityPort, ContextPause } from "./context.ts";
import type { EngineeringContinuation } from "./continuation.ts";
import type {
  PhysicalIntegrationAuthorityPort,
  PhysicalIntegrationReceipt,
} from "./physical.ts";

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
  readonly contextBudget: ContextBudgetAuthorityPort;
  readonly physicalIntegration: PhysicalIntegrationAuthorityPort;
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
}

export interface EngineeringReview extends WorkflowReview {
  readonly preview: EngineeringPreview;
}

export type EngineeringFailureCode =
  | WorkflowFailureCode
  | "SOURCE_ENGINEERING_REJECTED"
  | "CHANGE_ASSURANCE_REJECTED"
  | "CONTEXT_BUDGET_REJECTED"
  | "CONTEXT_BUDGET_DRIFTED"
  | "CONTINUATION_REJECTED"
  | "CONTINUATION_DRIFTED"
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
        ReturnType<import("../workflow/contract.ts").CausalWorkflow["prepare"]>
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
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_WORKFLOW_INPUT"
        | "SOURCE_ENGINEERING_REJECTED"
        | "CONTEXT_BUDGET_REJECTED";
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
}

export type EngineeringWorkflowResult =
  | { readonly status: "accepted"; readonly workflow: EngineeringWorkflow }
  | { readonly status: "rejected"; readonly code: "INVALID_WORKFLOW_CONFIG" };
