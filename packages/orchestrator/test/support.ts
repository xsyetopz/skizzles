import {
  createOrchestrator,
  type DiagnosticInterceptor,
  type EffectKind,
  type NormalizedRequest,
  type Orchestrator,
  type OrchestratorConfig,
  type StructuralProposal,
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
  };
  readonly applied: Uint8Array[];
} {
  const counts = {
    classify: 0,
    spawn: 0,
    apply: 0,
    graph: 0,
    measure: 0,
    repository: 0,
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
  return { orchestrator: created.orchestrator, counts, applied };
}

export function normalize(orchestrator: Orchestrator): NormalizedRequest {
  const result = orchestrator.normalize(requestBytes());
  if (result.status === "rejected") throw new Error("valid request rejected");
  return result.request;
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
