import type { StructuredCommandRequest } from "./command-policy.ts";

export type PortableSandboxMechanism =
  | "landlock"
  | "apparmor"
  | "container-user-namespace"
  | "seatbelt";

export interface SandboxCapabilityAttestation {
  readonly mechanism: PortableSandboxMechanism;
  readonly writePaths: readonly string[];
  readonly deniesUndeclaredWrites: true;
  readonly deniesSystemControl: true;
  readonly readOnlyWorktree: true;
  readonly networkDisabled: true;
  readonly boundedProcessTree: true;
  readonly evidence: string;
}

export interface SandboxCapabilityAuthority {
  readonly id: string;
}

export interface SandboxCapabilityAuthorityConfig {
  readonly id: string;
  readonly attest: (paths: readonly string[]) => unknown | Promise<unknown>;
  readonly execute: (
    request: SandboxAuthorityExecutionRequest,
  ) => unknown | Promise<unknown>;
}

export interface SandboxExecutionLimits {
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
  readonly drainMilliseconds: number;
  readonly signalGraceMilliseconds: number;
}

export interface SandboxAuthorityExecutionRequest {
  readonly attestationDigest: string;
  readonly writePaths: readonly string[];
  readonly command: StructuredCommandRequest;
  readonly worktreeRoot: string;
  readonly writeRoot: string;
  readonly bindingDigest: string;
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
  readonly drainMilliseconds: number;
  readonly signalGraceMilliseconds: number;
}
export interface PortableSandboxBroker {
  readonly negotiate: (
    paths: unknown,
  ) => Promise<PortableSandboxNegotiationResult>;
  readonly execute: (input: unknown) => Promise<SandboxExecutionResult>;
}

export interface PortableSandboxReceipt extends SandboxCapabilityAttestation {
  readonly authorityId: string;
  readonly receiptDigest: string;
}

export type PortableSandboxNegotiationResult =
  | Readonly<{ status: "accepted"; receipt: PortableSandboxReceipt }>
  | Readonly<{
      status: "rejected";
      code:
        | "INVALID_SANDBOX_TARGETS"
        | "CAPABILITY_UNAVAILABLE"
        | "CAPABILITY_MISMATCH";
    }>;

export interface SandboxExecutionReceipt extends SandboxExecutionLimits {
  readonly attestationDigest: string;
  readonly bindingDigest: string;
  readonly exitCode: number;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly outcomeDigest: string;
}

export type SandboxExecutionResult =
  | Readonly<{ status: "executed"; receipt: SandboxExecutionReceipt }>
  | Readonly<{
      status: "rejected";
      code:
        | "INVALID_EXECUTION_REQUEST"
        | "FORGED_ATTESTATION"
        | "ROOT_BINDING_REJECTED"
        | "COMMAND_REJECTED"
        | "EXECUTION_UNAVAILABLE"
        | "EXECUTION_MISMATCH";
    }>;
