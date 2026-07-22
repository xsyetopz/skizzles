import { ArtifactRegistry, type ArtifactValidator } from "../artifact.ts";
import type { VerificationAuthorityPort } from "../checkpoint.ts";
import { exactKeys, isRecord, nonempty, stringArray } from "../codec.ts";
import type { DiagnosticInterceptor } from "../diagnostic.ts";
import type { NormalizedRequest } from "../intent.ts";
import type { PreflightApproval, RepositoryGraphPort } from "../preflight.ts";
import type {
  EffectClassification,
  EffectClassificationAuthorityPort,
  RepositoryAuthorityPort,
  RepositoryContext,
} from "../repository.ts";
import type { MeasurementAuthorityPort, StructuralPort } from "../review.ts";
import type { ApprovalAuthorityPort } from "./approval.ts";
import {
  type DiscoveryAuthorityPort,
  type DiscoveryPolicy,
  parseDiscoveryPolicy,
} from "./discovery.ts";
import {
  type ClockPort,
  type CompletionAuthorityPort,
  type ExecutionBudgets,
  parseCompletionContract,
  parseExecutionBudgets,
} from "./execution.ts";
import type { TargetAuthorityPort } from "./target.ts";

export interface NonEffectSpawnPort {
  spawn(input: {
    readonly effect: "none";
    readonly request: NormalizedRequest;
    readonly repository: RepositoryContext;
    readonly preflight: PreflightApproval;
    readonly classification: EffectClassification;
  }): unknown | Promise<unknown>;
}

export interface OrchestratorConfig {
  readonly repositoryAuthority: RepositoryAuthorityPort;
  readonly effectClassificationAuthority: EffectClassificationAuthorityPort;
  readonly graph: RepositoryGraphPort;
  readonly measurementAuthority: MeasurementAuthorityPort;
  readonly verificationAuthority: VerificationAuthorityPort;
  readonly nonEffectSpawn: NonEffectSpawnPort;
  readonly structural: StructuralPort;
  readonly targetAuthority: TargetAuthorityPort;
  readonly clock: ClockPort;
  readonly completionAuthority: CompletionAuthorityPort;
  readonly executionBudgets: ExecutionBudgets;
  readonly completionContract: {
    readonly id: string;
    readonly checks: readonly string[];
  };
  readonly discoveryAuthority: DiscoveryAuthorityPort;
  readonly discoveryPolicy: DiscoveryPolicy;
  readonly approvalAuthority: ApprovalAuthorityPort;
  readonly approvalTtlMs: number;
  readonly artifactValidators: readonly ArtifactValidator[];
  readonly requiredInvariants: readonly string[];
  readonly outputCaps: {
    readonly tokens: number;
    readonly bytes: number;
  };
  readonly diagnosticInterceptor?: DiagnosticInterceptor;
}

export function parseOrchestratorConfig(
  input: unknown,
): OrchestratorConfig | undefined {
  if (!hasConfigShape(input)) return;
  const repositoryCapture = method(input.repositoryAuthority, "capture");
  const effectClassify = method(
    input.effectClassificationAuthority,
    "classify",
  );
  const graphInspect = method(input.graph, "inspect");
  const measure = method(input.measurementAuthority, "measure");
  const verificationCapture = method(input.verificationAuthority, "capture");
  const spawn = method(input.nonEffectSpawn, "spawn");
  const apply = method(input.structural, "apply");
  const targetCapture = memberMethod(input.targetAuthority, "capture", [
    "capture",
    "revalidate",
  ]);
  const targetRevalidate = memberMethod(input.targetAuthority, "revalidate", [
    "capture",
    "revalidate",
  ]);
  const clockNow = zeroArgumentMethod(input.clock, "now");
  const completionVerify = method(input.completionAuthority, "verify");
  const discoveryScan = memberMethod(input.discoveryAuthority, "scan", [
    "scan",
    "reviewExpansion",
  ]);
  const reviewExpansion = memberMethod(
    input.discoveryAuthority,
    "reviewExpansion",
    ["scan", "reviewExpansion"],
  );
  const authenticate = method(input.approvalAuthority, "authenticate");
  const executionBudgets = parseExecutionBudgets(input.executionBudgets);
  const completionContract = parseCompletionContract(input.completionContract);
  const discoveryPolicy = parseDiscoveryPolicy(input.discoveryPolicy);
  const validators = ArtifactRegistry.parseValidators(
    input.artifactValidators,
    input.outputCaps.tokens,
    input.outputCaps.bytes,
  );
  const requiredInvariants = stringArray(input.requiredInvariants);
  const interceptor = Object.hasOwn(input, "diagnosticInterceptor")
    ? method(input.diagnosticInterceptor, "intercept")
    : undefined;
  if (
    repositoryCapture === undefined ||
    effectClassify === undefined ||
    graphInspect === undefined ||
    measure === undefined ||
    verificationCapture === undefined ||
    spawn === undefined ||
    apply === undefined ||
    targetCapture === undefined ||
    targetRevalidate === undefined ||
    clockNow === undefined ||
    completionVerify === undefined ||
    discoveryScan === undefined ||
    reviewExpansion === undefined ||
    authenticate === undefined ||
    executionBudgets === undefined ||
    completionContract === undefined ||
    discoveryPolicy === undefined ||
    !positiveInteger(input.approvalTtlMs) ||
    validators === undefined ||
    requiredInvariants === undefined ||
    requiredInvariants.length === 0 ||
    requiredInvariants.some((id) => !nonempty(id, 128)) ||
    new Set(requiredInvariants).size !== requiredInvariants.length ||
    (Object.hasOwn(input, "diagnosticInterceptor") && interceptor === undefined)
  ) {
    return;
  }
  return Object.freeze({
    repositoryAuthority: { capture: repositoryCapture },
    effectClassificationAuthority: { classify: effectClassify },
    graph: { inspect: graphInspect },
    measurementAuthority: { measure },
    verificationAuthority: { capture: verificationCapture },
    nonEffectSpawn: { spawn },
    structural: { apply },
    targetAuthority: { capture: targetCapture, revalidate: targetRevalidate },
    clock: { now: clockNow },
    completionAuthority: { verify: completionVerify },
    executionBudgets,
    completionContract,
    discoveryAuthority: { scan: discoveryScan, reviewExpansion },
    discoveryPolicy,
    approvalAuthority: { authenticate },
    approvalTtlMs: input.approvalTtlMs,
    artifactValidators: validators,
    requiredInvariants,
    outputCaps: Object.freeze({
      tokens: input.outputCaps.tokens,
      bytes: input.outputCaps.bytes,
    }),
    ...(interceptor === undefined
      ? {}
      : { diagnosticInterceptor: { intercept: interceptor } }),
  });
}

function hasConfigShape(
  input: unknown,
): input is ReturnType<typeof configShape> {
  return (
    isRecord(input) &&
    exactKeys(
      input,
      [
        "repositoryAuthority",
        "effectClassificationAuthority",
        "graph",
        "measurementAuthority",
        "verificationAuthority",
        "nonEffectSpawn",
        "structural",
        "targetAuthority",
        "clock",
        "completionAuthority",
        "executionBudgets",
        "completionContract",
        "discoveryAuthority",
        "discoveryPolicy",
        "approvalAuthority",
        "approvalTtlMs",
        "artifactValidators",
        "requiredInvariants",
        "outputCaps",
      ],
      ["diagnosticInterceptor"],
    ) &&
    isRecord(input.outputCaps) &&
    exactKeys(input.outputCaps, ["tokens", "bytes"]) &&
    typeof input.outputCaps.tokens === "number" &&
    typeof input.outputCaps.bytes === "number"
  );
}

function configShape() {
  return {
    repositoryAuthority: undefined,
    effectClassificationAuthority: undefined,
    graph: undefined,
    measurementAuthority: undefined,
    verificationAuthority: undefined,
    nonEffectSpawn: undefined,
    structural: undefined,
    targetAuthority: undefined,
    clock: undefined,
    completionAuthority: undefined,
    executionBudgets: undefined,
    completionContract: undefined,
    discoveryAuthority: undefined,
    discoveryPolicy: undefined,
    approvalAuthority: undefined,
    approvalTtlMs: 0,
    artifactValidators: undefined,
    requiredInvariants: undefined,
    outputCaps: { tokens: 0, bytes: 0 },
    diagnosticInterceptor: undefined,
  } satisfies Record<string, unknown>;
}

function memberMethod(
  value: unknown,
  name: string,
  names: readonly string[],
): ((input: unknown) => unknown | Promise<unknown>) | undefined {
  if (
    !(isRecord(value) && exactKeys(value, names)) ||
    typeof value[name] !== "function"
  )
    return;
  const implementation = value[name];
  return (input: unknown) => Reflect.apply(implementation, value, [input]);
}

function zeroArgumentMethod(
  value: unknown,
  name: string,
): (() => unknown) | undefined {
  if (
    !(isRecord(value) && exactKeys(value, [name])) ||
    typeof value[name] !== "function"
  )
    return;
  const implementation = value[name];
  return () => Reflect.apply(implementation, value, []);
}

function method(
  value: unknown,
  name: string,
): ((input: unknown) => unknown | Promise<unknown>) | undefined {
  if (
    !(isRecord(value) && exactKeys(value, [name])) ||
    typeof value[name] !== "function"
  )
    return;
  const implementation = value[name];
  return (input: unknown) => Reflect.apply(implementation, value, [input]);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}
