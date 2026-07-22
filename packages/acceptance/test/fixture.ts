import { createCandidateManifest } from "@skizzles/candidate-manifest";
import { digestValue, type VerificationDigest } from "../src/digest.ts";
import {
  createChangeAssuranceAuthority,
  createCoverageAuthority,
  createExclusionAuthority,
  createIndependentReviewer,
  createMutationEngineAuthority,
  createOriginalTestAuthority,
  createPhysicalEvidenceAuthority,
  createPropertyEngineAuthority,
  createSourceEvidenceAuthority,
  createTaskWorktreeEvidenceAuthority,
  createVerificationGate,
  type VerificationAuthorityRequest,
  type VerificationBindings,
  type VerificationGate,
  type VerificationGateConfig,
  type VerificationGateInput,
} from "../src/index.ts";

export interface FixtureModes {
  sourceManifest: "valid" | "omitted" | "forged";
  assuranceManifest: "valid" | "omitted" | "forged" | "reordered";
  taskManifest: "valid" | "omitted" | "forged";
  mixedProfileManifests: boolean;
  mutation: "killed" | "survived" | "timeout" | "invalid";
  excludeInvalid: boolean;
  originalPassed: boolean;
  originalOverlayDrift: boolean;
  propertyCounterexample: boolean;
  propertyReachesNode: boolean;
  propertyReachesBranch: boolean;
  propertyExecutedCases: number | null;
  propertyCompleted: boolean;
  propertyExecutedExtremes: boolean;
  nodeHits: number;
  lineHits: number;
  omitCoverageLine: boolean;
  forgeCoverageLine: boolean;
  forgeCoverageObjectiveDigest: boolean;
  branchHits: number;
  reviewer: "accepted" | "rejected";
  artifactBytes: number;
}

export interface GateFixture {
  readonly gate: VerificationGate;
  readonly input: VerificationGateInput;
  readonly bindings: VerificationBindings;
  readonly config: VerificationGateConfig;
  readonly modes: FixtureModes;
  readonly calls: string[];
  readonly coveragePayloads: unknown[];
}

const d = (label: string): VerificationDigest => digestValue(label);

export function createGateFixture(
  mutationEvaluator?: (
    request: VerificationAuthorityRequest,
  ) => unknown | Promise<unknown>,
): GateFixture {
  const calls: string[] = [];
  const coveragePayloads: unknown[] = [];
  const modes: FixtureModes = {
    sourceManifest: "valid",
    assuranceManifest: "valid",
    taskManifest: "valid",
    mixedProfileManifests: false,
    mutation: "killed",
    excludeInvalid: false,
    originalPassed: true,
    originalOverlayDrift: false,
    propertyCounterexample: false,
    propertyReachesNode: true,
    propertyReachesBranch: true,
    propertyExecutedCases: null,
    propertyCompleted: true,
    propertyExecutedExtremes: true,
    nodeHits: 2,
    lineHits: 2,
    omitCoverageLine: false,
    forgeCoverageLine: false,
    forgeCoverageObjectiveDigest: false,
    branchHits: 2,
    reviewer: "accepted",
    artifactBytes: 1024,
  };
  const evidence = Object.freeze({
    source: Object.freeze({ receipt: "source" }),
    changeAssurance: Object.freeze({ receipt: "assurance" }),
    taskWorktree: Object.freeze([
      Object.freeze({ receipt: "original-tests" }),
      Object.freeze({ receipt: "mutation" }),
      Object.freeze({ receipt: "property" }),
      Object.freeze({ receipt: "coverage" }),
    ]),
    physical: Object.freeze({ receipt: "physical" }),
    originalTests: Object.freeze({ receipt: "baseline" }),
  });
  const manifestEntries = Object.freeze([
    Object.freeze({
      path: "src/a.ts",
      operation: "write" as const,
      contentDigest: d("candidate-a"),
    }),
    Object.freeze({
      path: "src/b.ts",
      operation: "write" as const,
      contentDigest: d("candidate-b"),
    }),
  ]);
  const candidateManifestDigest =
    createCandidateManifest(manifestEntries).manifestDigest;
  const reorderedManifestDigest = digestValue({
    entries: Object.freeze([...manifestEntries].reverse()),
  });
  const input: VerificationGateInput = Object.freeze({
    version: 1,
    taskId: "task-6",
    taskEpochDigest: d("task-epoch"),
    requestDigest: d("request"),
    repositoryId: "repository",
    rootIdentity: "root-identity",
    treeDigest: d("tree"),
    baselineDigest: d("baseline"),
    candidateDigest: d("candidate"),
    candidateManifestDigest,
    specLockDigest: d("spec-lock"),
    baselineManifestDigest: d("baseline-manifest"),
    evidence,
  });
  const bindings: VerificationBindings = Object.freeze({
    taskId: input.taskId,
    taskEpochDigest: input.taskEpochDigest,
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    rootIdentity: input.rootIdentity,
    treeDigest: input.treeDigest,
    baselineDigest: input.baselineDigest,
    candidateDigest: input.candidateDigest,
    candidateManifestDigest: input.candidateManifestDigest,
    specLockDigest: input.specLockDigest,
    baselineManifestDigest: input.baselineManifestDigest,
  });
  const source = register(
    createSourceEvidenceAuthority,
    "source",
    (request) => {
      calls.push(request.purpose);
      return Object.freeze({
        status: "valid",
        bindingDigest: request.bindingDigest,
        evidenceDigest: d("source-evidence"),
        ...(modes.sourceManifest === "omitted"
          ? {}
          : {
              candidateManifestDigest:
                modes.sourceManifest === "valid"
                  ? candidateManifestDigest
                  : d("forged-source-manifest"),
            }),
        structuralReceiptDigest: d("structural"),
        compilerChainDigest: d("compiler-chain"),
        complexityEvidenceDigest: d("complexity"),
        modifiedNodes: Object.freeze([
          Object.freeze({
            nodeId: "node-1",
            nodeDigest: d("node"),
            pathDigest: d("path"),
            kind: "function",
            lineIds: Object.freeze([d("line-1"), d("line-2")]),
            branchIds: Object.freeze(["branch-1"]),
            mutationSites: Object.freeze([
              Object.freeze({
                siteId: "operator-1",
                kind: "operator",
                variants: Object.freeze([
                  Object.freeze({ variantId: "gte-to-gt" }),
                  Object.freeze({ variantId: "gte-to-lt" }),
                ]),
              }),
            ]),
            complexityDigest: d("node-complexity"),
          }),
        ]),
      });
    },
  );
  const assurance = register(
    createChangeAssuranceAuthority,
    "assurance",
    (request) => {
      calls.push(request.purpose);
      return Object.freeze({
        status: "valid",
        bindingDigest: request.bindingDigest,
        evidenceDigest: d("assurance-evidence"),
        candidateDigest: bindings.candidateDigest,
        ...(modes.assuranceManifest === "omitted"
          ? {}
          : {
              candidateManifestDigest:
                modes.assuranceManifest === "valid"
                  ? candidateManifestDigest
                  : modes.assuranceManifest === "reordered"
                    ? reorderedManifestDigest
                    : d("forged-assurance-manifest"),
            }),
      });
    },
  );
  const task = register(
    createTaskWorktreeEvidenceAuthority,
    "task-worktree",
    (request) => {
      calls.push(request.purpose);
      return Object.freeze({
        status: "valid",
        bindingDigest: request.bindingDigest,
        evidenceDigest: d("task-evidence"),
        ...(modes.taskManifest === "omitted"
          ? {}
          : {
              candidateManifestDigest:
                modes.taskManifest === "valid"
                  ? candidateManifestDigest
                  : d("forged-task-manifest"),
            }),
        viewDigest: d("view"),
        baselineTestManifestDigest: bindings.baselineManifestDigest,
        candidateTestManifestDigest: d("candidate-test-manifest"),
        specificationLockDigest: bindings.specLockDigest,
        artifactReceiptDigest: d("artifact"),
        profileReceiptDigests: Object.freeze({
          originalTests: d("profile-original"),
          mutation: d("profile-mutation"),
          property: d("profile-property"),
          coverage: d("profile-coverage"),
        }),
        profileCandidateManifestDigests: Object.freeze({
          originalTests: candidateManifestDigest,
          mutation: modes.mixedProfileManifests
            ? d("mixed-profile-manifest")
            : candidateManifestDigest,
          property: candidateManifestDigest,
          coverage: candidateManifestDigest,
        }),
        artifactByteLength: modes.artifactBytes,
      });
    },
  );
  const physical = register(
    createPhysicalEvidenceAuthority,
    "physical",
    (request) => {
      calls.push(request.purpose);
      return Object.freeze({
        status: "valid",
        bindingDigest: request.bindingDigest,
        evidenceDigest: d("physical-evidence"),
        candidateDigest: bindings.candidateDigest,
        isolationDigest: d("physical-isolation"),
      });
    },
  );
  const original = register(
    createOriginalTestAuthority,
    "original",
    (request) => {
      calls.push(request.purpose);
      return Object.freeze({
        status: "valid",
        bindingDigest: request.bindingDigest,
        evidenceDigest: d("original-evidence"),
        baselineManifestDigest: bindings.baselineManifestDigest,
        candidateDigest: bindings.candidateDigest,
        candidateManifestDigest,
        productionOverlayDigest: modes.originalOverlayDrift
          ? d("drifted-overlay")
          : d("view"),
        isolationDigest: d("container-isolation"),
        testCount: 4,
        passed: modes.originalPassed,
        profileReceiptDigest: d("profile-original"),
        viewDigest: d("view"),
      });
    },
  );
  const mutation = register(
    createMutationEngineAuthority,
    "mutation",
    async (request) => {
      calls.push(request.purpose);
      if (mutationEvaluator !== undefined)
        return await mutationEvaluator(request);
      const payload = request.payload as Readonly<{
        inventory: readonly Readonly<{ mutantId: VerificationDigest }>[];
        inventoryDigest: VerificationDigest;
      }>;
      return Object.freeze({
        status: "valid",
        bindingDigest: request.bindingDigest,
        evidenceDigest: d(`mutation-${modes.mutation}`),
        candidateManifestDigest,
        inventoryDigest: payload.inventoryDigest,
        profileReceiptDigest: d("profile-mutation"),
        outcomes: Object.freeze(
          payload.inventory.map(({ mutantId }) =>
            Object.freeze({
              mutantId,
              outcome: modes.mutation,
              evidenceDigest: d(`outcome-${modes.mutation}`),
            }),
          ),
        ),
      });
    },
  );
  const property = register(
    createPropertyEngineAuthority,
    "property",
    (request) => {
      calls.push(request.purpose);
      const payload = request.payload as Readonly<{
        structuralReceiptDigest: VerificationDigest;
        seedScheduleDigest: VerificationDigest;
        requiredCaseCount: number;
        requiredRandomCaseCount: number;
        requiredExtremeVectorDigests: readonly VerificationDigest[];
      }>;
      return Object.freeze({
        status: "valid",
        bindingDigest: request.bindingDigest,
        evidenceDigest: d("property-evidence"),
        candidateManifestDigest,
        structuralReceiptDigest: payload.structuralReceiptDigest,
        profileReceiptDigest: d("profile-property"),
        specLockDigest: bindings.specLockDigest,
        seedScheduleDigest: payload.seedScheduleDigest,
        requiredCaseCount: payload.requiredCaseCount,
        extremeVectorInventoryDigest: digestValue(
          payload.requiredExtremeVectorDigests,
        ),
        properties: Object.freeze([
          Object.freeze({
            propertyId: "property-1",
            nodeIds: Object.freeze(modes.propertyReachesNode ? ["node-1"] : []),
            branchIds: Object.freeze(
              modes.propertyReachesBranch ? ["branch-1"] : [],
            ),
            executedCases:
              modes.propertyExecutedCases ?? payload.requiredCaseCount,
            executedRandomCases: payload.requiredRandomCaseCount,
            executedExtremeCases: modes.propertyExecutedExtremes
              ? payload.requiredExtremeVectorDigests.length
              : 0,
            completed: modes.propertyCompleted,
            executedExtremeVectorDigests: modes.propertyExecutedExtremes
              ? payload.requiredExtremeVectorDigests
              : Object.freeze([]),
            counterexampleDigest: modes.propertyCounterexample
              ? d("counterexample")
              : null,
          }),
        ]),
      });
    },
  );
  const coverage = register(createCoverageAuthority, "coverage", (request) => {
    calls.push(request.purpose);
    coveragePayloads.push(request.payload);
    const payload = request.payload as Readonly<{
      structuralReceiptDigest: VerificationDigest;
      coverageObjectiveDigest: VerificationDigest;
    }>;
    return Object.freeze({
      status: "valid",
      bindingDigest: request.bindingDigest,
      evidenceDigest: d("coverage-evidence"),
      candidateManifestDigest,
      structuralReceiptDigest: payload.structuralReceiptDigest,
      profileReceiptDigest: d("profile-coverage"),
      coverageObjectiveDigest: modes.forgeCoverageObjectiveDigest
        ? d("forged-coverage-objective")
        : payload.coverageObjectiveDigest,
      nodes: Object.freeze([
        Object.freeze({
          nodeId: "node-1",
          hits: modes.nodeHits,
          lines: Object.freeze(
            modes.omitCoverageLine
              ? [Object.freeze({ lineId: d("line-1"), hits: modes.lineHits })]
              : [
                  Object.freeze({
                    lineId: d("line-1"),
                    hits: modes.lineHits,
                  }),
                  Object.freeze({
                    lineId: modes.forgeCoverageLine
                      ? d("forged-line")
                      : d("line-2"),
                    hits: modes.lineHits,
                  }),
                ],
          ),
          branches: Object.freeze([
            Object.freeze({ branchId: "branch-1", hits: modes.branchHits }),
          ]),
        }),
      ]),
    });
  });
  const exclusions = register(
    createExclusionAuthority,
    "exclusions",
    (request) => {
      calls.push(request.purpose);
      const payload = request.payload as Readonly<{
        mutant: Readonly<{ mutantId: VerificationDigest }>;
      }>;
      return Object.freeze({
        status: modes.excludeInvalid ? "authorized" : "rejected",
        bindingDigest: request.bindingDigest,
        mutantId: payload.mutant.mutantId,
        classification: "equivalent",
        authorizationDigest: d("exclusion"),
      });
    },
  );
  const reviewer = register(
    createIndependentReviewer,
    "reviewer",
    (request) => {
      calls.push(request.purpose);
      const payload = request.payload as Readonly<{
        reviewContextDigest: VerificationDigest;
      }>;
      return Object.freeze({
        status: modes.reviewer,
        bindingDigest: request.bindingDigest,
        reviewContextDigest: payload.reviewContextDigest,
        reviewDigest: d(`review-${modes.reviewer}`),
      });
    },
  );

  const config: VerificationGateConfig = Object.freeze({
    authorityId: "verification-gate",
    sourceEvidence: source,
    changeAssurance: assurance,
    taskWorktree: task,
    physicalEvidence: physical,
    originalTests: original,
    mutation,
    property,
    coverageAuthority: coverage,
    exclusions,
    reviewer,
    coverage: Object.freeze({
      minimumNodeHits: 2,
      minimumLineHits: 2,
      minimumBranchHits: 2,
    }),
    fuzz: Object.freeze({
      rootSeed: 42,
      seeds: 64,
      casesPerSeed: 100,
      dimensions: 3,
      minimum: -1000,
      maximum: 1000,
      extremes: Object.freeze([-1000, -1, 0, 1, 1000]),
    }),
    limits: Object.freeze({
      modifiedNodes: 100,
      linesPerNode: 100,
      branchesPerNode: 100,
      mutationSitesPerNode: 100,
      variantsPerSite: 20,
      properties: 100,
      artifactBytes: 1_000_000,
    }),
  });
  const creation = createVerificationGate(config);
  if (creation.status !== "created") throw new Error("gate creation failed");
  return {
    gate: creation.verificationGate,
    input,
    bindings,
    config,
    modes,
    calls,
    coveragePayloads,
  };
}

function register<Authority>(
  factory: (
    input: unknown,
  ) =>
    | Readonly<{ status: "created"; authority: Authority }>
    | Readonly<{ status: "rejected"; code: string }>,
  id: string,
  evaluate: (
    request: VerificationAuthorityRequest,
  ) => unknown | Promise<unknown>,
): Authority {
  const result = factory(Object.freeze({ id, evaluate }));
  if (result.status !== "created") throw new Error(`authority ${id} failed`);
  return result.authority;
}
