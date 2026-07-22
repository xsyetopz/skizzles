import type { Digest } from "../../digest.ts";

export type StableCommandName =
  | "locate.symbol"
  | "locate.text"
  | "patch.apply"
  | "verify.tests";

export interface LocateSymbolCommand {
  readonly command: "locate.symbol";
  readonly root: string;
  readonly symbol: string;
}

export interface LocateTextCommand {
  readonly command: "locate.text";
  readonly root: string;
  readonly query: string;
}

export interface ApplyPatchCommand {
  readonly command: "patch.apply";
  readonly patchDigest: Digest;
  readonly paths: readonly string[];
}

export interface VerifyTestsCommand {
  readonly command: "verify.tests";
  readonly testIds: readonly string[];
}

export type StableCommandRequest =
  | LocateSymbolCommand
  | LocateTextCommand
  | ApplyPatchCommand
  | VerifyTestsCommand;

export interface ExecutionObservation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly observationDigest: Digest;
}

export interface ExecutionCommandAuthorityPort {
  readonly authorityId: string;
  locateSymbol: (
    request: LocateSymbolCommand,
  ) => CodeActSandboxRequest | Promise<CodeActSandboxRequest>;
  locateText: (
    request: LocateTextCommand,
  ) => CodeActSandboxRequest | Promise<CodeActSandboxRequest>;
  applyPatch: (
    request: ApplyPatchCommand,
  ) => CodeActSandboxRequest | Promise<CodeActSandboxRequest>;
  verifyTests: (
    request: VerifyTestsCommand,
  ) => CodeActSandboxRequest | Promise<CodeActSandboxRequest>;
}

export interface ExecutionCommandCatalog {
  readonly schema: "skizzles.orchestrator/execution-command-catalog/v1";
  readonly authorityId: string;
  readonly commands: readonly StableCommandName[];
  execute: (request: unknown) => Promise<CommandExecutionResult>;
}

export type CommandExecutionResult =
  | {
      readonly status: "completed";
      readonly command: StableCommandName;
      readonly observation: ExecutionObservation;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_COMMAND"
        | "COMMAND_AUTHORITY_FAILED"
        | "INVALID_COMMAND_OUTPUT";
    };

export type CommandCatalogCreationResult =
  | {
      readonly status: "created";
      readonly catalog: ExecutionCommandCatalog;
    }
  | {
      readonly status: "rejected";
      readonly code: "INVALID_COMMAND_AUTHORITY" | "UNTRUSTED_CODEACT_EXECUTOR";
    };

export interface CodeActSandboxRequest {
  readonly executionId: string;
  readonly language: "typescript";
  readonly source: string;
  readonly workingDirectory: string;
  readonly timeoutMilliseconds: number;
}

export interface CodeActSandboxAuthorityPort {
  readonly authorityId: string;
  execute: (request: CodeActSandboxRequest) => unknown | Promise<unknown>;
}

export interface CodeActSandboxCapability {
  readonly schema: "skizzles.orchestrator/codeact-sandbox-capability/v1";
  readonly authorityId: string;
}

export type SandboxCapabilityCreationResult =
  | {
      readonly status: "created";
      readonly capability: CodeActSandboxCapability;
    }
  | {
      readonly status: "rejected";
      readonly code: "INVALID_SANDBOX_AUTHORITY";
    };

export interface CodeActExecutor {
  readonly schema: "skizzles.orchestrator/codeact-executor/v1";
  readonly authorityId: string;
  execute: (request: unknown) => Promise<CodeActExecutionResult>;
}

export type CodeActExecutorCreationResult =
  | { readonly status: "created"; readonly executor: CodeActExecutor }
  | { readonly status: "rejected"; readonly code: "UNTRUSTED_SANDBOX" };

export type CodeActExecutionResult =
  | {
      readonly status: "completed";
      readonly executionId: string;
      readonly observation: ExecutionObservation;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_CODEACT_REQUEST"
        | "SANDBOX_AUTHORITY_FAILED"
        | "INVALID_SANDBOX_OUTPUT";
    };

export type AgentlessStage = "locate" | "patch" | "verify";

export interface AgentlessTask {
  readonly taskId: string;
  readonly objectiveDigest: Digest;
  readonly locate: LocateSymbolCommand | LocateTextCommand;
  readonly patch: ApplyPatchCommand;
  readonly verify: VerifyTestsCommand;
}

export interface AgentlessSession {
  readonly executionId: Digest;
  readonly taskId: string;
  readonly objectiveDigest: Digest;
  readonly stage: AgentlessStage;
  readonly version: number;
}

export interface AgentlessExecutor {
  readonly schema: "skizzles.orchestrator/agentless-executor/v1";
  start: (input: unknown) => AgentlessStartResult;
  advance: (input: unknown) => Promise<AgentlessAdvanceResult>;
}

export type AgentlessExecutorCreationResult =
  | { readonly status: "created"; readonly executor: AgentlessExecutor }
  | { readonly status: "rejected"; readonly code: "UNTRUSTED_COMMAND_CATALOG" };

export type AgentlessStartResult =
  | { readonly status: "started"; readonly session: AgentlessSession }
  | { readonly status: "rejected"; readonly code: "INVALID_AGENTLESS_TASK" };

export type AgentlessAdvanceResult =
  | {
      readonly status: "advanced";
      readonly completedStage: "locate" | "patch";
      readonly observation: ExecutionObservation;
      readonly session: AgentlessSession;
    }
  | {
      readonly status: "completed";
      readonly completedStage: "verify";
      readonly observation: ExecutionObservation;
      readonly executionId: Digest;
    }
  | {
      readonly status: "failed";
      readonly failedStage: AgentlessStage;
      readonly observation: ExecutionObservation;
      readonly executionId: Digest;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_AGENTLESS_ADVANCE"
        | "AGENTLESS_SESSION_STALE"
        | "COMMAND_REJECTED";
    };

export interface ReActSession {
  readonly sessionId: Digest;
  readonly taskId: string;
  readonly objectiveDigest: Digest;
  readonly step: number;
  readonly maximumSteps: number;
}

export interface ReActActionTurn {
  readonly kind: "action";
  readonly command: StableCommandRequest;
}

export interface ReActFinalTurn {
  readonly kind: "final";
  readonly answer: string;
}

export type ReActTurn = ReActActionTurn | ReActFinalTurn;

export interface ReActController {
  readonly schema: "skizzles.orchestrator/react-controller/v1";
  readonly maximumSteps: number;
  start: (input: unknown) => ReActStartResult;
  advance: (input: unknown) => Promise<ReActAdvanceResult>;
}

export type ReActControllerCreationResult =
  | { readonly status: "created"; readonly controller: ReActController }
  | {
      readonly status: "rejected";
      readonly code: "INVALID_REACT_CONFIG" | "UNTRUSTED_COMMAND_CATALOG";
    };

export type ReActStartResult =
  | { readonly status: "started"; readonly session: ReActSession }
  | { readonly status: "rejected"; readonly code: "INVALID_REACT_TASK" };

export type ReActAdvanceResult =
  | {
      readonly status: "observed";
      readonly observation: ExecutionObservation;
      readonly session: ReActSession;
    }
  | {
      readonly status: "completed";
      readonly answer: string;
      readonly sessionId: Digest;
      readonly steps: number;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_REACT_TURN"
        | "REACT_SESSION_STALE"
        | "REACT_STEP_BUDGET_EXHAUSTED"
        | "COMMAND_REJECTED";
    };
