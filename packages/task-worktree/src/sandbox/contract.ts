import type { StructuredCommandRequest } from "./command-policy.ts";

export type SandboxVerificationObjective =
  | Readonly<{
      readonly kind: "original-tests";
      readonly structuralReceiptDigest: `sha256:${string}`;
      readonly baselineTestManifestDigest: `sha256:${string}`;
      readonly productionOverlayDigest: `sha256:${string}`;
      readonly containerImageDigest: `sha256:${string}`;
      readonly containerEvidenceDigest: `sha256:${string}`;
    }>
  | Readonly<{
      readonly kind: "mutation";
      readonly structuralReceiptDigest: `sha256:${string}`;
      readonly inventoryDigest: `sha256:${string}`;
      readonly mutantIds: readonly `sha256:${string}`[];
    }>
  | Readonly<{
      readonly kind: "property";
      readonly structuralReceiptDigest: `sha256:${string}`;
      readonly seedScheduleDigest: `sha256:${string}`;
      readonly requiredRandomFuzzCaseCount: number;
      readonly requiredExtremeVectorCount: number;
      readonly requiredCaseCount: number;
      readonly requiredExtremeVectorDigests: readonly `sha256:${string}`[];
      readonly extremeVectorInventoryDigest: `sha256:${string}`;
      readonly nodeIds: readonly `sha256:${string}`[];
      readonly branchIds: readonly `sha256:${string}`[];
    }>
  | Readonly<{
      readonly kind: "coverage";
      readonly structuralReceiptDigest: `sha256:${string}`;
      readonly modifiedNodes: readonly Readonly<{
        readonly nodeId: `sha256:${string}`;
        readonly lineIds: readonly `sha256:${string}`[];
        readonly branchIds: readonly `sha256:${string}`[];
      }>[];
      readonly thresholds: Readonly<{
        readonly minimumNodeHits: number;
        readonly minimumLineHits: number;
        readonly minimumBranchHits: number;
      }>;
    }>;

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
  readonly verificationObjective?: SandboxVerificationObjective;
  readonly objectiveDigest?: `sha256:${string}`;
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
