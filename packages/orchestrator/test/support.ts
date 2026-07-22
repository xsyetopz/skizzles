import {
  createOrchestrator,
  type DiagnosticInterceptor,
  type DiscoverySnapshot,
  type EffectKind,
  type NormalizedRequest,
  type Orchestrator,
  type OrchestratorConfig,
  type RepositoryContext,
  type StructuralProposal,
  type TargetBaseline,
} from "../src/index.ts";

const encoder = new TextEncoder();

export type EffectClassificationInput = Parameters<
  OrchestratorConfig["effectClassificationAuthority"]["classify"]
>[0];

export function effectClassificationResult(
  input: EffectClassificationInput,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    effect: "none",
    requestDigest: input.request.intentDigest,
    rawDigest: input.request.rawDigest,
    repositoryId: input.repository.repositoryId,
    treeDigest: input.repository.treeDigest,
    contextDigest: input.repository.contextDigest,
    policyId: "fixture-effect-policy-v1",
    evidenceId: "fixture-effect-evidence",
    ...overrides,
  };
}

export function requestBytes(
  overrides: Readonly<Record<string, unknown>> = {},
): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      version: 1,
      action: "ANALYZE",
      subject: "Access Report",
      descriptors: ["please", "atomic"],
      negations: ["Do NOT remove audit logging"],
      identifiers: ["AuthToken", "src/Admin.ts"],
      quotedText: ['"Keep THIS copy"'],
      scope: ["packages/Auth", "API/V2"],
      securitySeverity: "critical",
      userCopy: "Inspect audit logging and report `AuthToken` exactly.",
      ...overrides,
    }),
  );
}

interface RawRun {
  readonly commandBytes: readonly number[];
  readonly outputBytes: readonly number[];
  readonly exitCode: number;
}

export interface RawEvidence {
  readonly treeBytes: readonly number[];
  readonly compiler: RawRun;
  readonly tests: RawRun;
  readonly verifier: RawRun;
}

export function verificationEvidence(label: string): RawEvidence {
  return {
    treeBytes: Array.from(encoder.encode(`tree:${label}`)),
    compiler: run(`typecheck:${label}`),
    tests: run(`tests:${label}`),
    verifier: run(`verify:${label}`),
  };
}

function run(label: string): RawRun {
  return {
    commandBytes: Array.from(encoder.encode(`bun run ${label}`)),
    outputBytes: Array.from(encoder.encode(`output:${label}`)),
    exitCode: 0,
  };
}

interface HarnessOptions {
  readonly repositoryCapture?: OrchestratorConfig["repositoryAuthority"]["capture"];
  readonly effect?: EffectKind;
  readonly effectClassification?: OrchestratorConfig["effectClassificationAuthority"]["classify"];
  readonly graphState?: "satisfied" | "violated" | "approval-required";
  readonly graphResult?: (input: {
    readonly repositoryId: string;
    readonly requestDigest: string;
    readonly treeDigest: string;
  }) => unknown;
  readonly spawnOutput?: unknown;
  readonly measurements?: (proposal: StructuralProposal) => unknown;
  readonly verification?: readonly unknown[];
  readonly interceptor?: DiagnosticInterceptor;
  readonly structuralApply?: OrchestratorConfig["structural"]["apply"];
  readonly tokenCap?: number;
  readonly byteCap?: number;
  readonly targetCapture?: OrchestratorConfig["targetAuthority"]["capture"];
  readonly targetRevalidate?: OrchestratorConfig["targetAuthority"]["revalidate"];
  readonly completionVerify?: OrchestratorConfig["completionAuthority"]["verify"];
  readonly discoveryScan?: OrchestratorConfig["discoveryAuthority"]["scan"];
  readonly reviewExpansion?: OrchestratorConfig["discoveryAuthority"]["reviewExpansion"];
  readonly authenticate?: OrchestratorConfig["approvalAuthority"]["authenticate"];
  readonly executionActions?: number;
}

export function createHarness(options: HarnessOptions = {}): {
  readonly orchestrator: Orchestrator;
  readonly counts: {
    classify: number;
    spawn: number;
    apply: number;
    graph: number;
    measure: number;
    repository: number;
    targetCapture: number;
    targetRevalidate: number;
    completion: number;
    discovery: number;
    expansion: number;
    authenticate: number;
  };
  readonly applied: Uint8Array[];
  readonly clock: {
    now(): number;
    set(value: number): void;
    advance(value: number): void;
  };
} {
  const counts = {
    classify: 0,
    spawn: 0,
    apply: 0,
    graph: 0,
    measure: 0,
    repository: 0,
    targetCapture: 0,
    targetRevalidate: 0,
    completion: 0,
    discovery: 0,
    expansion: 0,
    authenticate: 0,
  };
  let now = 1000;
  const clock = {
    now: () => now,
    set(value: number) {
      now = value;
    },
    advance(value: number) {
      now += value;
    },
  };
  const applied: Uint8Array[] = [];
  const verification = [
    ...(options.verification ?? [verificationEvidence("default")]),
  ];
  let verificationIndex = 0;
  const config: OrchestratorConfig = {
    repositoryAuthority: {
      capture(input) {
        counts.repository += 1;
        if (options.repositoryCapture !== undefined) {
          return options.repositoryCapture(input);
        }
        return {
          repositoryId: input.repositoryId,
          requestDigest: input.requestDigest,
          treeBytes: Array.from(encoder.encode("tree:repository")),
          anchors: [
            {
              id: "runtime",
              precedence: "language-runtime",
              contentBytes: Array.from(encoder.encode("bun:1.3.14")),
            },
          ],
        };
      },
    },
    effectClassificationAuthority: {
      classify(input) {
        counts.classify += 1;
        if (options.effectClassification !== undefined) {
          return options.effectClassification(input);
        }
        return effectClassificationResult(input, {
          effect: options.effect ?? "none",
        });
      },
    },
    graph: {
      inspect(input) {
        counts.graph += 1;
        if (options.graphResult !== undefined)
          return options.graphResult(input);
        return {
          repositoryId: input.repositoryId,
          requestDigest: input.requestDigest,
          treeDigest: input.treeDigest,
          snapshotBytes: Array.from(encoder.encode("graph:snapshot")),
          invariants: [
            {
              id: "dependency-direction",
              state: options.graphState ?? "satisfied",
              evidence: [
                {
                  source: "repository-graph",
                  bytes: Array.from(encoder.encode("edge:a->b")),
                },
              ],
            },
          ],
        };
      },
    },
    measurementAuthority: {
      measure(proposal) {
        counts.measure += 1;
        if (options.measurements !== undefined)
          return options.measurements(proposal);
        return measurementResult(proposal, 5, 7);
      },
    },
    verificationAuthority: {
      capture() {
        const result =
          verification[Math.min(verificationIndex, verification.length - 1)];
        verificationIndex += 1;
        return result;
      },
    },
    nonEffectSpawn: {
      spawn() {
        counts.spawn += 1;
        return (
          options.spawnOutput ?? {
            artifacts: [
              {
                kind: "code",
                bytes: Array.from(
                  encoder.encode("export const safe = true;\n"),
                ),
              },
            ],
            presentation: ["Completed safely."],
            diagnostics: [],
          }
        );
      },
    },
    structural: {
      apply(input) {
        counts.apply += 1;
        if (options.structuralApply !== undefined) {
          return options.structuralApply(input);
        }
        applied.push(Uint8Array.from(input.payloadBytes));
        return { target: input.target, ref: input.payloadRef };
      },
    },
    targetAuthority: {
      capture(input) {
        counts.targetCapture += 1;
        if (options.targetCapture !== undefined)
          return options.targetCapture(input);
        return {
          reservationId: input.reservationId,
          repositoryId: input.repositoryId,
          requestDigest: input.requestDigest,
          treeDigest: input.treeDigest,
          targets: input.targets,
          headBytes: [1],
          indexBytes: [2],
          worktreeBytes: [3],
          statusBytes: [4],
          statuses: input.targets.map((path) => ({ path, state: "clean" })),
        };
      },
      revalidate(input) {
        counts.targetRevalidate += 1;
        if (options.targetRevalidate !== undefined)
          return options.targetRevalidate(input);
        return {
          reservationId: input.reservationId,
          repositoryId: input.repositoryId,
          requestDigest: input.requestDigest,
          treeDigest: input.treeDigest,
          targets: input.targets,
          headDigest: input.headDigest,
          indexDigest: input.indexDigest,
          worktreeDigest: input.worktreeDigest,
          statusDigest: input.statusDigest,
          unchanged: true,
        };
      },
    },
    clock: { now: clock.now },
    completionAuthority: {
      verify(input) {
        counts.completion += 1;
        if (options.completionVerify !== undefined)
          return options.completionVerify(input);
        return {
          executionId: input.executionId,
          requestDigest: input.request.intentDigest,
          repositoryId: input.repository.repositoryId,
          treeDigest: input.repository.treeDigest,
          contractId: input.contractId,
          checks: input.requiredChecks.map((id, index) => ({
            id,
            passed: true,
            evidenceBytes: [index + 1],
          })),
        };
      },
    },
    executionBudgets: {
      low: {
        actions: options.executionActions ?? 4,
        retries: 2,
        repeatedCausalFailures: 2,
        wallClockMs: 1000,
      },
      medium: {
        actions: options.executionActions ?? 3,
        retries: 2,
        repeatedCausalFailures: 2,
        wallClockMs: 800,
      },
      high: {
        actions: options.executionActions ?? 2,
        retries: 1,
        repeatedCausalFailures: 1,
        wallClockMs: 500,
      },
    },
    completionContract: {
      id: "phase-two",
      checks: ["lint", "compiler", "target-tests"],
    },
    discoveryAuthority: {
      scan(input) {
        counts.discovery += 1;
        if (options.discoveryScan !== undefined)
          return options.discoveryScan(input);
        return {
          repositoryId: input.repositoryId,
          requestDigest: input.requestDigest,
          treeDigest: input.treeDigest,
          root: input.root,
          entries: [
            { path: `${input.root}/src`, kind: "directory", bytes: 0 },
            { path: `${input.root}/src/index.ts`, kind: "file", bytes: 100 },
          ],
          skippedSymlinks: [`${input.root}/vendor-link`],
          complete: true,
          stoppedBy: null,
          ...(input.taskId === undefined
            ? {}
            : {
                taskId: input.taskId,
                taskEpochDigest: input.taskEpochDigest,
              }),
        };
      },
      reviewExpansion(input) {
        counts.expansion += 1;
        if (options.reviewExpansion !== undefined)
          return options.reviewExpansion(input);
        return {
          discoveryDigest: input.discoveryDigest,
          proposedRoot: input.proposedRoot,
          expansion: input.expansion,
          approved: true,
          reviewId: `expansion-${input.expansion}`,
        };
      },
    },
    discoveryPolicy: {
      includedRoots: ["packages"],
      exclusions: [
        "packages/orchestrator/node_modules",
        "packages/orchestrator/dist",
      ],
      bounds: { maxDepth: 8, maxFiles: 100, maxBytes: 100_000, maxMs: 100 },
      maxExpansions: 2,
    },
    approvalAuthority: {
      authenticate(input) {
        counts.authenticate += 1;
        if (options.authenticate !== undefined)
          return options.authenticate(input);
        return {
          challengeDigest: input.challenge.challengeDigest,
          taskId: input.challenge.taskId,
          principalId: input.challenge.principalId,
          operation: input.challenge.operation,
          authorized: input.token === "approve",
          verifiedAtMs: clock.now(),
        };
      },
    },
    approvalTtlMs: 200,
    artifactValidators: [
      {
        kind: "code",
        validate(bytes) {
          return new TextDecoder().decode(bytes).endsWith("\n")
            ? { valid: true }
            : { valid: false, code: "MISSING_NEWLINE" };
        },
      },
    ],
    requiredInvariants: ["dependency-direction"],
    outputCaps: {
      tokens: options.tokenCap ?? 128,
      bytes: options.byteCap ?? 2048,
    },
    ...(options.interceptor === undefined
      ? {}
      : { diagnosticInterceptor: options.interceptor }),
  };
  const created = createOrchestrator(config);
  if (created.status === "rejected")
    throw new Error("valid harness config rejected");
  return { orchestrator: created.orchestrator, counts, applied, clock };
}

export function normalize(orchestrator: Orchestrator): NormalizedRequest {
  const result = orchestrator.normalize(requestBytes());
  if (result.status === "rejected") throw new Error("valid request rejected");
  return result.request;
}

export async function repositoryContext(orchestrator: Orchestrator): Promise<{
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
}> {
  const request = normalize(orchestrator);
  const result = await orchestrator.preflight({
    request,
    repository: { id: "repo-a" },
  });
  if (result.status !== "accepted")
    throw new Error("valid repository rejected");
  return { request, repository: result.approval.repository };
}

export async function targetBaseline(
  orchestrator: Orchestrator,
  targets: readonly string[] = ["packages/orchestrator/src/runtime.ts"],
): Promise<{
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly baseline: TargetBaseline;
}> {
  const context = await repositoryContext(orchestrator);
  const result = await orchestrator.captureTargetBaseline({
    ...context,
    targets,
  });
  if (result.status !== "accepted") throw new Error("valid baseline rejected");
  return { ...context, baseline: result.baseline };
}

export async function discoverySnapshot(orchestrator: Orchestrator): Promise<{
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly discovery: DiscoverySnapshot;
}> {
  const context = await repositoryContext(orchestrator);
  const result = await orchestrator.discover({
    ...context,
    root: "packages/orchestrator",
  });
  if (result.status !== "accepted") throw new Error("valid discovery rejected");
  return { ...context, discovery: result.discovery };
}

export function proposal(orchestrator: Orchestrator): StructuralProposal {
  const result = orchestrator.proposeChange({
    target: "manifest",
    payloadRef: "workspace:package.json",
    payloadBytes: Array.from(encoder.encode('{"private":true}\n')),
    limits: [
      { dimension: "security", direction: "higher-is-better", limit: 6 },
      { dimension: "performance", direction: "higher-is-better", limit: 6 },
      { dimension: "maintenance", direction: "higher-is-better", limit: 6 },
    ],
  });
  if (result.status === "rejected") throw new Error("valid proposal rejected");
  return result.proposal;
}

export function measurementResult(
  proposal: StructuralProposal,
  current: number,
  proposed: number,
) {
  return {
    proposalDigest: proposal.proposalDigest,
    measurements: (["security", "performance", "maintenance"] as const).map(
      (dimension) => ({
        dimension,
        unit: `${dimension}-score`,
        direction: "higher-is-better",
        current,
        proposed,
        currentEvidenceBytes: Array.from(
          encoder.encode(`${dimension}:current`),
        ),
        proposedEvidenceBytes: Array.from(
          encoder.encode(`${dimension}:proposed`),
        ),
      }),
    ),
  };
}
