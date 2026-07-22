import { createCandidateManifest } from "@skizzles/candidate-manifest";
import {
  isTaskWorktreeVerificationReceipt,
  type TaskWorktreeVerificationReceipt,
} from "@skizzles/task-worktree";
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
  isVerificationGateReceipt,
  type VerificationAuthorityRequest,
  type VerificationGate,
} from "@skizzles/verification-gate";
import { exactKeys, isRecord } from "../../codec.ts";
import { digestValue } from "../../digest.ts";
import type {
  WorkflowVerificationAuthority,
  WorkflowVerificationAuthorityConfig,
  WorkflowVerificationAuthorityCreationResult,
  WorkflowVerificationBindings,
  WorkflowVerificationEvaluationInput,
  WorkflowVerificationEvidence,
  WorkflowVerificationMaterial,
  WorkflowVerificationMaterialInput,
} from "./contract.ts";
import { deriveVerificationObjectives } from "./objectives.ts";
import {
  coverageReport,
  mutationReport,
  originalReport,
  propertyReport,
} from "./reports/artifacts.ts";
import {
  assuranceReport,
  physicalReport,
  sourceReport,
} from "./reports/engineering.ts";
import {
  invalidVerificationConfig,
  isVerificationDigest,
  validVerificationAuthorityConfig,
  validVerificationMaterial,
  verificationEvaluationBinds,
  verificationRoleId,
} from "./validation.ts";

interface MaterialState {
  readonly owner: object;
  readonly input: WorkflowVerificationMaterialInput;
}

interface EvaluationState {
  readonly input: WorkflowVerificationEvaluationInput;
}

const authorities = new WeakSet<object>();
const materials = new WeakMap<object, MaterialState>();

export function createWorkflowVerificationAuthority(
  config: WorkflowVerificationAuthorityConfig,
): WorkflowVerificationAuthorityCreationResult {
  if (!validVerificationAuthorityConfig(config))
    return invalidVerificationConfig();
  const owner = Object.freeze({});
  const evaluations = new WeakMap<object, EvaluationState>();
  const receiptEvaluations = new WeakMap<object, EvaluationState>();
  const receiptDigests = new Map<
    string,
    Readonly<{
      state: EvaluationState;
      receipt: TaskWorktreeVerificationReceipt;
    }>
  >();
  const resolveEngineeringMaterial = (
    request: VerificationAuthorityRequest,
  ) => {
    if (stateFor(request, evaluations) === undefined) return;
    return materialFor(request.payload, owner)?.input;
  };
  const resolveOriginalReceipt = (
    request: VerificationAuthorityRequest,
    value: unknown,
  ): TaskWorktreeVerificationReceipt | undefined => {
    if (!isTaskWorktreeVerificationReceipt(value)) return;
    const state = receiptEvaluations.get(value);
    return state !== undefined &&
      value === state.input.receipts.originalTests &&
      sameBindings(request.bindings, state.input.bindings)
      ? value
      : undefined;
  };
  const resolveCandidateReceipt = (
    request: VerificationAuthorityRequest,
    receiptDigest: unknown,
    kind: "coverage" | "mutation" | "property",
  ): TaskWorktreeVerificationReceipt | undefined => {
    const found = stateAndReceipt(receiptDigest, kind, receiptDigests);
    return found !== undefined &&
      sameBindings(request.bindings, found.state.input.bindings)
      ? found.receipt
      : undefined;
  };
  const source = createSourceEvidenceAuthority(
    Object.freeze({
      id: verificationRoleId(config.authorityId, "source"),
      evaluate: (request: VerificationAuthorityRequest) =>
        sourceReport(request, resolveEngineeringMaterial),
    }),
  );
  const assurance = createChangeAssuranceAuthority(
    Object.freeze({
      id: verificationRoleId(config.authorityId, "assurance"),
      evaluate: (request: VerificationAuthorityRequest) =>
        assuranceReport(request, resolveEngineeringMaterial),
    }),
  );
  const task = createTaskWorktreeEvidenceAuthority(
    Object.freeze({
      id: verificationRoleId(config.authorityId, "task"),
      evaluate: (request: VerificationAuthorityRequest) =>
        taskReport(request, receiptEvaluations),
    }),
  );
  const physical = createPhysicalEvidenceAuthority(
    Object.freeze({
      id: verificationRoleId(config.authorityId, "physical"),
      evaluate: (request: VerificationAuthorityRequest) =>
        physicalReport(request, resolveEngineeringMaterial),
    }),
  );
  const original = createOriginalTestAuthority(
    Object.freeze({
      id: verificationRoleId(config.authorityId, "original"),
      evaluate: (request: VerificationAuthorityRequest) =>
        originalReport(request, resolveOriginalReceipt),
    }),
  );
  const mutation = createMutationEngineAuthority(
    Object.freeze({
      id: verificationRoleId(config.authorityId, "mutation"),
      evaluate: (request: VerificationAuthorityRequest) =>
        mutationReport(request, resolveCandidateReceipt),
    }),
  );
  const property = createPropertyEngineAuthority(
    Object.freeze({
      id: verificationRoleId(config.authorityId, "property"),
      evaluate: (request: VerificationAuthorityRequest) =>
        propertyReport(request, resolveCandidateReceipt),
    }),
  );
  const coverage = createCoverageAuthority(
    Object.freeze({
      id: verificationRoleId(config.authorityId, "coverage"),
      evaluate: (request: VerificationAuthorityRequest) =>
        coverageReport(request, resolveCandidateReceipt),
    }),
  );
  const exclusions = createExclusionAuthority(
    Object.freeze({
      id: config.exclusions.id,
      evaluate: (request: VerificationAuthorityRequest) =>
        config.exclusions.evaluate(request),
    }),
  );
  const reviewer = createIndependentReviewer(
    Object.freeze({
      id: config.reviewer.id,
      evaluate: (request: VerificationAuthorityRequest) =>
        config.reviewer.evaluate(request),
    }),
  );
  if (
    source.status !== "created" ||
    assurance.status !== "created" ||
    task.status !== "created" ||
    physical.status !== "created" ||
    original.status !== "created" ||
    mutation.status !== "created" ||
    property.status !== "created" ||
    coverage.status !== "created" ||
    exclusions.status !== "created" ||
    reviewer.status !== "created"
  ) {
    return invalidVerificationConfig();
  }
  const created = createVerificationGate(
    Object.freeze({
      authorityId: config.authorityId,
      sourceEvidence: source.authority,
      changeAssurance: assurance.authority,
      taskWorktree: task.authority,
      physicalEvidence: physical.authority,
      originalTests: original.authority,
      mutation: mutation.authority,
      property: property.authority,
      coverageAuthority: coverage.authority,
      exclusions: exclusions.authority,
      reviewer: reviewer.authority,
      coverage: config.coverage,
      fuzz: config.fuzz,
      limits: config.limits,
    }),
  );
  if (created.status !== "created") return invalidVerificationConfig();
  const authority = makeAuthority(
    created.verificationGate,
    evaluations,
    receiptEvaluations,
    receiptDigests,
    config,
    owner,
  );
  authorities.add(authority);
  return Object.freeze({ status: "created" as const, authority });
}

export function isWorkflowVerificationAuthority(
  value: unknown,
): value is WorkflowVerificationAuthority {
  return typeof value === "object" && value !== null && authorities.has(value);
}

function makeAuthority(
  gate: VerificationGate,
  evaluations: WeakMap<object, EvaluationState>,
  receiptEvaluations: WeakMap<object, EvaluationState>,
  receiptDigests: Map<
    string,
    Readonly<{
      state: EvaluationState;
      receipt: TaskWorktreeVerificationReceipt;
    }>
  >,
  config: WorkflowVerificationAuthorityConfig,
  owner: object,
): WorkflowVerificationAuthority {
  return Object.freeze({
    schema: "skizzles.orchestrator/workflow-verification-authority" as const,
    issue: (input: WorkflowVerificationMaterialInput) =>
      issueMaterial(input, owner),
    deriveObjectives: (material: WorkflowVerificationMaterial) =>
      deriveObjectives(material, config, owner),
    evaluate: async (input: WorkflowVerificationEvaluationInput) => {
      const material = materials.get(input.material);
      if (
        material === undefined ||
        material.owner !== owner ||
        !verificationEvaluationBinds(input, material.input)
      ) {
        return Object.freeze({
          status: "rejected" as const,
          code: "INVALID_INPUT" as const,
          failures: Object.freeze(["INVALID_INPUT" as const]),
        });
      }
      const state: EvaluationState = Object.freeze({ input });
      evaluations.set(input.material, state);
      for (const receipt of input.receipts.ordered) {
        receiptEvaluations.set(receipt, state);
        receiptDigests.set(
          receipt.receiptDigest,
          Object.freeze({ state, receipt }),
        );
      }
      const gateInput = Object.freeze({
        version: 1 as const,
        ...input.bindings,
        evidence: Object.freeze({
          source: input.material,
          changeAssurance: input.material,
          taskWorktree: input.receipts.ordered,
          physical: input.material,
          originalTests: input.receipts.originalTests,
        }),
      });
      const result = await gate.evaluate(gateInput);
      if (result.status !== "accepted") return result;
      if (!isVerificationGateReceipt(result.receipt)) {
        return Object.freeze({
          status: "rejected" as const,
          code: "REPLAY_REJECTED" as const,
          failures: Object.freeze(["REPLAY_REJECTED" as const]),
        });
      }
      return Object.freeze({
        status: "accepted" as const,
        evidence: Object.freeze({ input: gateInput, receipt: result.receipt }),
      });
    },
    verify: async (evidence: WorkflowVerificationEvidence) =>
      await gate.verify(
        Object.freeze({
          evaluation: evidence.input,
          receipt: evidence.receipt,
        }),
      ),
  });
}

function deriveObjectives(
  material: WorkflowVerificationMaterial,
  config: WorkflowVerificationAuthorityConfig,
  owner: object,
): ReturnType<typeof deriveVerificationObjectives> {
  const state = materials.get(material);
  return state === undefined || state.owner !== owner
    ? undefined
    : deriveVerificationObjectives(state.input, config);
}

function issueMaterial(
  input: WorkflowVerificationMaterialInput,
  owner: object,
): WorkflowVerificationMaterial | undefined {
  if (!(validVerificationMaterial(input) && captureSourceVerification(input)))
    return;
  const material: WorkflowVerificationMaterial = Object.freeze({
    schema: "skizzles.orchestrator/workflow-verification-material" as const,
  });
  materials.set(material, Object.freeze({ owner, input }));
  return material;
}

async function taskReport(
  request: VerificationAuthorityRequest,
  receiptEvaluations: WeakMap<object, EvaluationState>,
): Promise<unknown> {
  const payload = record(request.payload, ["receipts"]);
  const receipts =
    payload === undefined ? undefined : array(payload["receipts"]);
  const first = receipts?.[0];
  const state = object(first) ? receiptEvaluations.get(first) : undefined;
  if (
    state === undefined ||
    receipts === undefined ||
    receipts.length !== 4 ||
    receipts.some((receipt) => !isTaskWorktreeVerificationReceipt(receipt)) ||
    !sameBindings(request.bindings, state.input.bindings) ||
    receipts.some(
      (receipt, index) => receipt !== state.input.receipts.ordered[index],
    )
  ) {
    return;
  }
  for (const receipt of state.input.receipts.ordered) {
    if (
      !(
        isTaskWorktreeVerificationReceipt(receipt) &&
        (await verifyTaskReceipt(state, receipt))
      )
    ) {
      return;
    }
  }
  const { receipts: verified } = state.input;
  return Object.freeze({
    status: "valid" as const,
    bindingDigest: request.bindingDigest,
    evidenceDigest: digestValue(
      verified.ordered.map(({ receiptDigest }) => receiptDigest),
    ),
    candidateManifestDigest: verified.originalTests.candidateManifestDigest,
    viewDigest: verified.originalTests.viewReceiptDigest,
    artifactReceiptDigest: digestValue(
      verified.ordered.map(
        ({ artifactReceiptDigest }) => artifactReceiptDigest,
      ),
    ),
    profileReceiptDigests: Object.freeze({
      originalTests: verified.originalTests.receiptDigest,
      mutation: verified.mutation.receiptDigest,
      property: verified.property.receiptDigest,
      coverage: verified.coverage.receiptDigest,
    }),
    profileCandidateManifestDigests: Object.freeze({
      originalTests: verified.originalTests.candidateManifestDigest,
      mutation: verified.mutation.candidateManifestDigest,
      property: verified.property.candidateManifestDigest,
      coverage: verified.coverage.candidateManifestDigest,
    }),
    baselineTestManifestDigest:
      verified.originalTests.baselineTestManifestDigest,
    candidateTestManifestDigest:
      verified.originalTests.candidateTestManifestDigest,
    specificationLockDigest: verified.originalTests.specificationLockDigest,
    artifactByteLength: verified.ordered.reduce(
      (total, receipt) => total + receipt.artifact.byteLength,
      0,
    ),
  });
}

function stateFor(
  request: VerificationAuthorityRequest,
  evaluations: WeakMap<object, EvaluationState>,
): EvaluationState | undefined {
  if (!object(request.payload)) return;
  const state = evaluations.get(request.payload);
  if (
    state === undefined ||
    !sameBindings(request.bindings, state.input.bindings)
  ) {
    return;
  }
  return state;
}

function materialFor(value: unknown, owner: object): MaterialState | undefined {
  const state = object(value) ? materials.get(value) : undefined;
  return state?.owner === owner ? state : undefined;
}

function captureSourceVerification(
  input: WorkflowVerificationMaterialInput,
): boolean {
  const { source } = input;
  const receipt = source.receipt;
  const compilerReceipt = ownData(receipt, "compilerReceipt");
  if (
    !Object.isFrozen(receipt) ||
    ownData(receipt, "requestDigest") !== source.summary.requestDigest ||
    ownData(receipt, "candidateDigest") !== source.summary.candidateDigest ||
    ownData(receipt, "candidateManifestDigest") !==
      source.summary.candidateManifestDigest ||
    ownData(receipt, "provenanceDigest") !== source.summary.provenanceDigest ||
    ownData(receipt, "validationDigest") !== source.summary.validationDigest ||
    ownData(receipt, "structuralReceipt") !==
      source.summary.structuralReceipt ||
    sourceReceiptCandidateManifestDigest(receipt) !==
      source.summary.candidateManifestDigest ||
    !object(compilerReceipt) ||
    !Object.isFrozen(compilerReceipt) ||
    ownData(compilerReceipt, "receiptDigest") !==
      source.summary.compilerReceiptDigest
  ) {
    return false;
  }
  let verified: unknown;
  try {
    verified = source.authority.verify(
      Object.freeze({ artifacts: source.artifacts, receipt }),
    );
  } catch {
    return false;
  }
  const result = record(verified, [
    "status",
    "candidateDigest",
    "provenanceDigest",
    "validationDigest",
  ]);
  return (
    result?.["status"] === "valid" &&
    result["candidateDigest"] === source.summary.candidateDigest &&
    result["provenanceDigest"] === source.summary.provenanceDigest &&
    result["validationDigest"] === source.summary.validationDigest
  );
}

function sourceReceiptCandidateManifestDigest(
  receipt: object,
): `sha256:${string}` | undefined {
  const targets = ownData(receipt, "targetReceipts");
  if (!(Array.isArray(targets) && Object.isFrozen(targets))) return;
  const entries = [];
  for (const target of targets) {
    if (!(object(target) && Object.isFrozen(target))) return;
    const path = ownData(target, "path");
    const contentDigest = ownData(target, "candidateDigest");
    if (typeof path !== "string" || !isVerificationDigest(contentDigest)) {
      return;
    }
    entries.push(
      Object.freeze({ path, operation: "write" as const, contentDigest }),
    );
  }
  try {
    return createCandidateManifest(entries).manifestDigest;
  } catch {
    return void 0;
  }
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function stateAndReceipt(
  receiptDigest: unknown,
  kind: "coverage" | "mutation" | "property",
  receipts: ReadonlyMap<
    string,
    Readonly<{
      state: EvaluationState;
      receipt: TaskWorktreeVerificationReceipt;
    }>
  >,
):
  | Readonly<{
      state: EvaluationState;
      receipt: TaskWorktreeVerificationReceipt;
    }>
  | undefined {
  if (!isVerificationDigest(receiptDigest)) return;
  const found = receipts.get(receiptDigest);
  return found?.receipt.profileKind === kind ? found : undefined;
}

async function verifyTaskReceipt(
  state: EvaluationState,
  receipt: TaskWorktreeVerificationReceipt,
): Promise<boolean> {
  try {
    return await state.input.taskWorktree.verifyVerificationReceipt(
      Object.freeze({
        version: 1 as const,
        session: state.input.session,
        receipt,
      }),
    );
  } catch {
    return false;
  }
}

function sameBindings(
  left: WorkflowVerificationBindings,
  right: WorkflowVerificationBindings,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.taskEpochDigest === right.taskEpochDigest &&
    left.requestDigest === right.requestDigest &&
    left.repositoryId === right.repositoryId &&
    left.rootIdentity === right.rootIdentity &&
    left.treeDigest === right.treeDigest &&
    left.baselineDigest === right.baselineDigest &&
    left.candidateDigest === right.candidateDigest &&
    left.candidateManifestDigest === right.candidateManifestDigest &&
    left.specLockDigest === right.specLockDigest &&
    left.baselineManifestDigest === right.baselineManifestDigest
  );
}

function record(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) && exactKeys(value, keys) ? value : undefined;
}

function array(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) && Object.isFrozen(value) ? value : undefined;
}

function object(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
