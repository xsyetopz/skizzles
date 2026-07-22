import type {
  ExternalSkillDirectoryReference,
  ReflexionMemoryQuery,
  ReflexionMemoryRecorder,
  ReflexionPersistenceReceipt,
} from "@skizzles/reflexion-memory";
import type { Digest } from "../digest.ts";
import type {
  EngineeringReview,
  EngineeringWorkflow,
} from "../engineering/contract.ts";
import type {
  ContextFragment,
  OutboundContextMiddleware,
  OutboundContextPayload,
  SpecificationContextAuthority,
} from "./context/contract.ts";
import type {
  AgentlessExecutor,
  ExecutionObservation,
  ReActController,
} from "./execution/contract.ts";
import type { RoutingAssignment } from "./routing-contract.ts";
import type { RoutingExperimentObserver } from "./routing-observer.ts";
import type {
  DependencyScheduler,
  SchedulerRunResult,
} from "./scheduler/contract.ts";

export type AgentRuntimeMode = "agentless" | "react";

export interface ModelDispatchRequest {
  readonly schema: "skizzles.orchestrator/model-dispatch-request/v1";
  readonly authorityId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly objectiveDigest: Digest;
  readonly mode: AgentRuntimeMode;
  readonly step: number;
  readonly memorySnapshotDigest: Digest;
  readonly context: OutboundContextPayload;
  readonly observation: ExecutionObservation | null;
  readonly routingAssignment: RoutingAssignment | null;
  readonly requestDigest: Digest;
}

export interface ModelDispatchAuthority {
  readonly schema: "skizzles.orchestrator/model-dispatch-authority/v1";
  readonly authorityId: string;
  readonly dispatch: (request: ModelDispatchRequest) => Promise<unknown>;
}

export type ModelDispatchAuthorityCreationResult =
  | Readonly<{ status: "created"; authority: ModelDispatchAuthority }>
  | Readonly<{ status: "rejected"; code: "INVALID_MODEL_DISPATCH_AUTHORITY" }>;

export interface AgentRuntimeConfig {
  readonly agentless: AgentlessExecutor;
  readonly engineering: EngineeringWorkflow;
  readonly react?: ReActController;
  readonly scheduler: DependencyScheduler;
  readonly context: OutboundContextMiddleware;
  readonly specifications: SpecificationContextAuthority;
  readonly memoryQuery: ReflexionMemoryQuery;
  readonly memoryRecorder: ReflexionMemoryRecorder;
  readonly modelDispatch: ModelDispatchAuthority;
  readonly routingObserver?: RoutingExperimentObserver;
  readonly skillReferences: readonly ExternalSkillDirectoryReference[];
}

export interface AgentRuntimeRunRequest {
  readonly taskId: string;
  readonly runId: string;
  readonly objectiveDigest: Digest;
  readonly request: unknown;
  readonly repository: unknown;
  readonly targets: readonly string[];
  readonly validationProfile: string;
  readonly changeDeclaration: unknown;
  readonly faultDeclarations: unknown;
  readonly integrations: readonly unknown[];
  readonly supportingFragments: readonly ContextFragment[];
  readonly routingAssignment?: RoutingAssignment | null;
  readonly mode?: AgentRuntimeMode;
}

export interface AgentRuntimeReceipt {
  readonly schema: "skizzles.orchestrator/agent-runtime-receipt/v1";
  readonly taskId: string;
  readonly runId: string;
  readonly objectiveDigest: Digest;
  readonly mode: AgentRuntimeMode;
  readonly memorySnapshotDigest: Digest | null;
  readonly contextPayloadDigest: Digest | null;
  readonly prioritizationReceiptDigest: Digest | null;
  readonly compressionReceiptDigest: Digest | null;
  readonly routingAssignmentDigest: Digest | null;
  readonly routingObservationDigest: Digest | null;
  readonly routingObservationStatus: "not-configured" | "recorded" | "failed";
  readonly dispatchRequestDigests: readonly Digest[];
  readonly executionId: Digest | null;
  readonly outcome: "completed" | "failed";
  readonly failureCode: string | null;
  readonly failureMemoryReceipt: ReflexionPersistenceReceipt | null;
  readonly failureMemoryStatus:
    | "not-required"
    | "recorded"
    | "recording-failed";
  readonly engineeringEvidenceDigest: Digest | null;
  readonly receiptDigest: Digest;
}

export type AgentRuntimeRunResult =
  | Readonly<{
      status: "awaiting-approval";
      review: EngineeringReview;
      receipt: AgentRuntimeReceipt;
    }>
  | Readonly<{ status: "failed"; code: string; receipt: AgentRuntimeReceipt }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_AGENT_RUNTIME_INPUT" | "REACT_NOT_CONFIGURED";
    }>;

export interface AgentRuntime {
  readonly schema: "skizzles.orchestrator/agent-runtime/v1";
  readonly defaultMode: "agentless";
  readonly run: (input: unknown) => Promise<AgentRuntimeRunResult>;
  readonly schedule: (input: unknown) => Promise<SchedulerRunResult>;
  readonly verifySchedule: DependencyScheduler["verify"];
  readonly approveAndPromote: EngineeringWorkflow["approveAndPromote"];
  readonly reject: EngineeringWorkflow["reject"];
  readonly recover: EngineeringWorkflow["recover"];
  readonly retryCleanup: EngineeringWorkflow["retryCleanup"];
  readonly resetContext: EngineeringWorkflow["resetContext"];
  readonly resumeContextReset: EngineeringWorkflow["resumeContextReset"];
}

export type AgentRuntimeCreationResult =
  | Readonly<{ status: "created"; runtime: AgentRuntime }>
  | Readonly<{ status: "rejected"; code: "INVALID_AGENT_RUNTIME_CONFIG" }>;
