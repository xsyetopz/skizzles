import type { SourceFile } from "typescript/unstable/ast";
import type {
  ChangeAssuranceExtension,
  ChangeAssuranceExtensionCreationResult,
  ChangeAssuranceExtensionInput,
  ChangeAssuranceExtensionResult,
  ChangeAssuranceTarget,
} from "../contract.ts";

export type SecurityDigest = `sha256:${string}`;

export type SecurityMiddleware = "rate-limit" | "audit-log" | "sanitize";

export type SecurityFindingCode =
  | "CANDIDATE_DIGEST_MISMATCH"
  | "INVALID_CANDIDATE"
  | "INVALID_CONFIG"
  | "SYNTAX_ERROR"
  | "ENTRYPOINT_NOT_FOUND"
  | "MISSING_MIDDLEWARE"
  | "SECURITY_BENCHMARK_FAILED"
  | "UNAUDITED_SECURITY_IMPORT"
  | "CUSTOM_CRYPTOGRAPHY"
  | "CUSTOM_SESSION_MANAGEMENT"
  | "MISSING_SECURE_INTERFACE"
  | "UNSAFE_EXECUTION_CONCATENATION"
  | "UNSAFE_DATABASE_CONCATENATION"
  | "UNSAFE_NETWORK_CONCATENATION"
  | "UNSAFE_TEMPLATE_TAINT"
  | "RAW_EXECUTION_PRIMITIVE"
  | "RAW_DATABASE_PRIMITIVE"
  | "RAW_NETWORK_PRIMITIVE"
  | "TAINTED_EXECUTION_FLOW"
  | "TAINTED_DATABASE_FLOW"
  | "TAINTED_NETWORK_FLOW"
  | "UNKNOWN_SECURITY_FLOW"
  | "DYNAMIC_SECURITY_DISPATCH"
  | "MIDDLEWARE_NOT_DOMINANT"
  | "UNRESOLVED_SECURITY_SYMBOL"
  | "SESSION_BOUNDARY_REJECTED"
  | "SESSION_BOUNDARY_FORGED";

export type SecurityTarget = ChangeAssuranceTarget;
export type SecurityAssessment = ChangeAssuranceExtensionInput;

export interface SecurityEntrypointSchema {
  readonly path: string;
  readonly exportName: string;
  readonly requiredMiddleware: readonly SecurityMiddleware[];
  readonly requiredSecureImports: readonly string[];
  readonly benchmarkIds: readonly string[];
}

export interface SecurityImportAudit {
  readonly module: string;
  readonly allowedImports: readonly string[];
  readonly capability:
    | "middleware"
    | "session"
    | "execution"
    | "database"
    | "network";
}

export interface SecurityInterfaceRule {
  readonly interfaceId: string;
  readonly module: string;
  readonly imports: readonly string[];
  readonly capability: "session" | "execution" | "database" | "network";
}

export interface SecurityBenchmark {
  readonly benchmarkId: string;
  readonly minimumRateLimitRequests?: number;
  readonly maximumRateLimitWindowMs?: number;
  readonly maximumRequestBytes?: number;
  readonly requiredAuditFields?: readonly string[];
  readonly sanitizerNames?: readonly string[];
}

export interface SecuritySinkRule {
  readonly capability: "execution" | "database" | "network";
  readonly names: readonly string[];
  readonly secureInterfaceIds: readonly string[];
}

export interface SecurityPolicyConfig {
  readonly schemaVersion: 1;
  readonly entrypoints: readonly SecurityEntrypointSchema[];
  readonly auditedImports: readonly SecurityImportAudit[];
  readonly secureInterfaces: readonly SecurityInterfaceRule[];
  readonly benchmarks: readonly SecurityBenchmark[];
  readonly sinks: readonly SecuritySinkRule[];
}

export interface SecurityFinding {
  readonly code: SecurityFindingCode;
  readonly severity: "high" | "critical";
  readonly confidence: "high" | "medium";
  readonly fingerprint: SecurityDigest;
  readonly traceDigest: SecurityDigest;
  readonly path: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export interface SecurityTargetReceipt {
  readonly path: string;
  readonly candidateDigest: SecurityDigest;
  readonly findings: readonly SecurityFinding[];
}

export interface SecurityAnalysisReceipt {
  readonly status: "accepted" | "rejected";
  readonly findingCount: number;
  readonly findings: readonly SecurityFinding[];
  readonly targetReceipts: readonly SecurityTargetReceipt[];
  readonly evidenceDigest: SecurityDigest;
}

export type SecurityExtensionCreationResult =
  ChangeAssuranceExtensionCreationResult;
export type SecurityAssuranceExtension = ChangeAssuranceExtension;
export type SecurityExtensionResult = ChangeAssuranceExtensionResult;

export interface ParsedSecuritySource {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sourceFile: SourceFile;
  readonly imports: ReadonlyMap<string, readonly string[]>;
  readonly importAliases: ReadonlyMap<string, string>;
  readonly importBindings: ReadonlyMap<
    string,
    Readonly<{ readonly module: string; readonly imported: string }>
  >;
  readonly declaredNames: ReadonlySet<string>;
  readonly exportedNames: ReadonlySet<string>;
  readonly middlewareNames: ReadonlySet<string>;
  readonly callSites: readonly SecurityCallSite[];
}

export interface SecurityCallSite {
  readonly name: string;
  readonly capability: "execution" | "database" | "network" | "unknown";
  readonly hasDynamicArgument: boolean;
  readonly hasTemplateSubstitution: boolean;
  readonly numericArguments: readonly number[];
  readonly positionalNumericArguments: readonly (number | null)[];
  readonly stringArguments: readonly string[];
  readonly objectPropertyNames: readonly string[];
  readonly line: number;
  readonly column: number;
}

export interface SessionBoundaryTarget {
  readonly path: string;
  readonly candidateDigest: SecurityDigest;
  readonly candidateBytes: readonly number[];
}

export type SessionBoundaryOperation =
  | "expiry"
  | "refresh"
  | "logout"
  | "role"
  | "unauthorized"
  | "unavailable";

export interface SessionProbeRequest {
  readonly operation: SessionBoundaryOperation;
  readonly candidateTargets: readonly SessionBoundaryTarget[];
  readonly sessionAgeMs: number;
  readonly remainingLifetimeMs: number;
}

export type SessionDecision = "allow" | "deny" | "expired" | "unavailable";
export type SessionState =
  | "active"
  | "refreshed"
  | "expired"
  | "logged-out"
  | "absent";

export interface SessionProbeObservation {
  readonly decision: SessionDecision;
  readonly state: SessionState;
  readonly role?: string;
}

export interface SessionBoundaryRuntime {
  readonly dispatch: (
    request: SessionProbeRequest,
  ) => Promise<SessionProbeObservation>;
}

export interface SessionBoundaryConfig {
  readonly requiredRole: string;
  readonly maximumSessionAgeMs: number;
  readonly refreshWindowMs: number;
}

export interface SessionBoundaryInput {
  readonly candidateTargets: readonly SessionBoundaryTarget[];
  readonly runtime: SessionBoundaryRuntime;
}

export interface SessionBoundaryRuntimeCreationResult {
  readonly status: "created";
  readonly runtime: SessionBoundaryRuntime;
}

export type SessionBoundaryRuntimeResult =
  | SessionBoundaryRuntimeCreationResult
  | Readonly<{ status: "rejected"; code: "INVALID_RUNTIME" }>;

export interface SessionBoundaryCaseReceipt {
  readonly operation: SessionBoundaryOperation;
  readonly requestDigest: SecurityDigest;
  readonly observationDigest: SecurityDigest;
}

export interface SessionBoundaryReceipt {
  readonly status: "accepted" | "rejected";
  readonly code?: "SESSION_BOUNDARY_REJECTED" | "SESSION_BOUNDARY_FORGED";
  readonly caseReceipts: readonly SessionBoundaryCaseReceipt[];
  readonly candidateSetDigest: SecurityDigest;
  readonly evidenceDigest: SecurityDigest;
}

export interface SessionBoundaryAuthority {
  readonly bindTargets: (
    targets: readonly SessionBoundaryTarget[],
  ) =>
    | Readonly<{ status: "bound"; targets: readonly SessionBoundaryTarget[] }>
    | Readonly<{ status: "rejected"; code: "INVALID_TARGETS" }>;
  readonly inspect: (
    input: SessionBoundaryInput,
  ) => Promise<SessionBoundaryReceipt>;
}

export type SessionBoundaryAuthorityCreationResult =
  | Readonly<{ status: "created"; authority: SessionBoundaryAuthority }>
  | Readonly<{ status: "rejected"; code: "INVALID_CONFIG" }>;
