import type {
  VerificationGate,
  VerificationGateConfig,
  VerificationGateCreationResult,
  VerificationGateFailureCode,
  VerificationGateInput,
  VerificationGateReceipt,
  VerificationGateResult,
} from "../contract.ts";
import { digestValue, isDigest } from "../digest.ts";
import {
  deterministicExtremeVectorDigests,
  deterministicFuzzCaseCount,
  deterministicFuzzRandomCaseCount,
  fuzzScheduleDigest,
} from "../fuzz.ts";
import { boundedInteger } from "../object.ts";
import {
  modifiedLineCount as countModifiedLines,
  coverageObjectiveFailures,
  createCoverageObjective,
  parseCoverageReport,
} from "./coverage.ts";
import {
  parseMutationReport,
  parsePropertyReport,
  parseSimpleEvidenceReport,
  parseTaskWorktreeReport,
} from "./evidence.ts";
import { inputBindings, parseGateConfig, parseGateInput } from "./input.ts";
import { authorityRequest as request, safeInvoke } from "./invoke.ts";
import { verifyEvaluation } from "./replay.ts";
import { bindingDigest } from "./report.ts";
import { authorizeExclusion, parseReviewer } from "./review.ts";
import { deriveMutationInventory, parseSourceReport } from "./source.ts";

// biome-ignore lint/security/noSecrets: This is a public receipt field name, not secret material.
const productionOverlayDigestField = "productionOverlayDigest";

const gates = new WeakSet<object>();
const receipts = new WeakSet<object>();
const receiptOwners = new WeakMap<
  object,
  Readonly<{ owner: object; input: VerificationGateInput }>
>();

export function createVerificationGate(
  input: unknown,
): VerificationGateCreationResult {
  let config: VerificationGateConfig | undefined;
  try {
    config = parseGateConfig(input);
  } catch {
    config = undefined;
  }
  if (config === undefined)
    return { status: "rejected", code: "INVALID_CONFIG" };
  const owner = Object.freeze({});
  const gate: VerificationGate = Object.freeze({
    evaluate: async (raw: unknown) => await evaluate(owner, config, raw),
    verify: async (raw: unknown) =>
      await verifyEvaluation({
        owner,
        raw,
        isReceipt: isVerificationGateReceipt,
        bindingFor: (receipt) => receiptOwners.get(receipt),
        evaluate: async (evaluation) =>
          await evaluate(owner, config, evaluation),
      }),
  });
  gates.add(gate);
  return { status: "created", verificationGate: gate };
}

export function isVerificationGate(input: unknown): input is VerificationGate {
  return typeof input === "object" && input !== null && gates.has(input);
}

export function isVerificationGateReceipt(
  input: unknown,
): input is VerificationGateReceipt {
  return typeof input === "object" && input !== null && receipts.has(input);
}

async function evaluate(
  owner: object,
  config: VerificationGateConfig,
  raw: unknown,
): Promise<VerificationGateResult> {
  let input: VerificationGateInput | undefined;
  try {
    input = parseGateInput(raw);
  } catch {
    input = undefined;
  }
  if (input === undefined) return rejection("INVALID_INPUT");
  const bindings = inputBindings(input);
  const sourceRaw = await safeInvoke(
    config.sourceEvidence,
    request("source-evidence", bindings, input.evidence.source),
  );
  const source = parseSourceReport(sourceRaw, bindings, config.limits);
  if (
    source === undefined ||
    source.candidateManifestDigest !== bindings.candidateManifestDigest
  ) {
    return rejection("SOURCE_EVIDENCE_REJECTED");
  }

  const assuranceRaw = await safeInvoke(
    config.changeAssurance,
    request("change-assurance", bindings, input.evidence.changeAssurance),
  );
  const assurance = parseSimpleEvidenceReport(assuranceRaw, bindings, [
    "candidateDigest",
    "candidateManifestDigest",
  ]);
  if (
    assurance === undefined ||
    !isDigest(assurance["evidenceDigest"]) ||
    assurance["candidateDigest"] !== bindings.candidateDigest ||
    assurance["candidateManifestDigest"] !== bindings.candidateManifestDigest
  )
    return rejection("CHANGE_ASSURANCE_REJECTED");

  const taskRaw = await safeInvoke(
    config.taskWorktree,
    request(
      "task-worktree",
      bindings,
      Object.freeze({
        receipts: input.evidence.taskWorktree,
      }),
    ),
  );
  const task = parseTaskWorktreeReport(taskRaw, bindings, config.limits);
  if (
    task === undefined ||
    task.candidateManifestDigest !== bindings.candidateManifestDigest ||
    Object.values(task.profileCandidateManifestDigests).some(
      (digest) => digest !== bindings.candidateManifestDigest,
    ) ||
    task.baselineTestManifestDigest !== bindings.baselineManifestDigest ||
    task.specificationLockDigest !== bindings.specLockDigest
  ) {
    return rejection("TASK_WORKTREE_REJECTED");
  }

  const physicalRaw = await safeInvoke(
    config.physicalEvidence,
    request("physical-evidence", bindings, input.evidence.physical),
  );
  const physical = parseSimpleEvidenceReport(physicalRaw, bindings, [
    "candidateDigest",
    "isolationDigest",
  ]);
  if (
    physical === undefined ||
    !isDigest(physical["evidenceDigest"]) ||
    physical["candidateDigest"] !== bindings.candidateDigest ||
    !isDigest(physical["isolationDigest"])
  )
    return rejection("AUTHORITY_REJECTED");

  const originalRaw = await safeInvoke(
    config.originalTests,
    request(
      "original-tests",
      bindings,
      Object.freeze({
        evidence: input.evidence.originalTests,
        profileReceiptDigest: task.profileReceiptDigests.originalTests,
        viewDigest: task.viewDigest,
      }),
    ),
  );
  const original = parseSimpleEvidenceReport(originalRaw, bindings, [
    "baselineManifestDigest",
    "candidateDigest",
    "candidateManifestDigest",
    productionOverlayDigestField,
    "isolationDigest",
    "testCount",
    "passed",
    "profileReceiptDigest",
    "viewDigest",
  ]);
  if (
    original === undefined ||
    !isDigest(original["evidenceDigest"]) ||
    original["baselineManifestDigest"] !== bindings.baselineManifestDigest ||
    original["candidateDigest"] !== bindings.candidateDigest ||
    original["candidateManifestDigest"] !== bindings.candidateManifestDigest ||
    original[productionOverlayDigestField] !== task.viewDigest ||
    !isDigest(original["isolationDigest"]) ||
    !boundedInteger(original["testCount"], 1, 10_000_000) ||
    typeof original["passed"] !== "boolean" ||
    original["profileReceiptDigest"] !==
      task.profileReceiptDigests.originalTests ||
    original["viewDigest"] !== task.viewDigest
  )
    return rejection("AUTHORITY_REJECTED");

  const inventory = deriveMutationInventory(source);
  if (inventory.length < 1) return rejection("MUTATION_INVENTORY_REJECTED");
  const inventoryDigest = digestValue(inventory);
  const mutationRaw = await safeInvoke(
    config.mutation,
    request(
      "mutation",
      bindings,
      Object.freeze({
        structuralReceiptDigest: source.structuralReceiptDigest,
        profileReceiptDigest: task.profileReceiptDigests.mutation,
        inventory,
        inventoryDigest,
      }),
    ),
  );
  const mutation = parseMutationReport(
    mutationRaw,
    bindings,
    inventory,
    task.profileReceiptDigests.mutation,
  );

  const expectedScheduleDigest = fuzzScheduleDigest(config.fuzz);
  const requiredFuzzCaseCount = deterministicFuzzCaseCount(config.fuzz);
  const requiredRandomFuzzCaseCount = deterministicFuzzRandomCaseCount(
    config.fuzz,
  );
  const requiredExtremeVectorDigests = deterministicExtremeVectorDigests(
    config.fuzz,
  );
  const propertyRaw = await safeInvoke(
    config.property,
    request(
      "property",
      bindings,
      Object.freeze({
        structuralReceiptDigest: source.structuralReceiptDigest,
        profileReceiptDigest: task.profileReceiptDigests.property,
        modifiedNodes: source.modifiedNodes,
        fuzz: config.fuzz,
        seedScheduleDigest: expectedScheduleDigest,
        requiredCaseCount: requiredFuzzCaseCount,
        requiredRandomCaseCount: requiredRandomFuzzCaseCount,
        requiredExtremeVectorDigests,
      }),
    ),
  );
  const property = parsePropertyReport(
    propertyRaw,
    bindings,
    source,
    config.limits,
    task.profileReceiptDigests.property,
    requiredFuzzCaseCount,
    requiredRandomFuzzCaseCount,
    requiredExtremeVectorDigests,
  );

  const coverageObjective = createCoverageObjective(
    source,
    task.profileReceiptDigests.coverage,
    config.coverage,
  );
  const coverageRaw = await safeInvoke(
    config.coverageAuthority,
    request("coverage", bindings, coverageObjective),
  );
  const coverage = parseCoverageReport(
    coverageRaw,
    bindings,
    source,
    task.profileReceiptDigests.coverage,
    coverageObjective.coverageObjectiveDigest,
  );

  const failures: VerificationGateFailureCode[] = [];
  if (original["passed"] !== true) failures.push("ORIGINAL_TESTS_REJECTED");
  if (mutation === undefined) {
    failures.push("MUTATION_INVENTORY_REJECTED");
  } else {
    for (const outcome of mutation.outcomes) {
      if (outcome.outcome === "survived") {
        pushUnique(failures, "MUTATION_SURVIVED");
      } else if (outcome.outcome === "timeout") {
        pushUnique(failures, "MUTATION_TIMEOUT");
      } else if (outcome.outcome === "invalid") {
        const authorized = await authorizeExclusion(
          config,
          bindings,
          outcome,
          inventory.find(({ mutantId }) => mutantId === outcome.mutantId),
        );
        if (!authorized) pushUnique(failures, "MUTATION_INVALID");
      }
    }
  }
  if (
    property === undefined ||
    property.seedScheduleDigest !== expectedScheduleDigest
  ) {
    failures.push("PROPERTY_REJECTED");
  } else {
    if (
      property.properties.some(
        ({ counterexampleDigest }) => counterexampleDigest !== null,
      )
    )
      failures.push("PROPERTY_COUNTEREXAMPLE");
    const reachedNodes = new Set(
      property.properties.flatMap(({ nodeIds }) => nodeIds),
    );
    const reachedBranches = new Set(
      property.properties.flatMap(({ branchIds }) => branchIds),
    );
    if (source.modifiedNodes.some(({ nodeId }) => !reachedNodes.has(nodeId))) {
      failures.push("MODIFIED_NODE_UNCOVERED");
    }
    if (
      source.modifiedNodes.some(({ branchIds }) =>
        branchIds.some((branchId) => !reachedBranches.has(branchId)),
      )
    )
      failures.push("MODIFIED_BRANCH_UNCOVERED");
  }
  if (coverage === undefined) {
    failures.push("COVERAGE_REJECTED");
  } else {
    for (const failure of coverageObjectiveFailures(
      coverage,
      config.coverage,
    )) {
      pushUnique(failures, failure);
    }
  }

  const coverageThresholdDigest = digestValue(config.coverage);
  const modifiedLineCount = countModifiedLines(source);

  const reviewContext = Object.freeze({
    bindingDigest: bindingDigest(bindings),
    sourceEvidenceDigest: source.evidenceDigest,
    candidateManifestDigest: bindings.candidateManifestDigest,
    changeAssuranceDigest: assurance["evidenceDigest"],
    taskWorktreeEvidenceDigest: task.evidenceDigest,
    physicalEvidenceDigest: physical["evidenceDigest"],
    originalTestReceiptDigest: original["evidenceDigest"],
    mutationInventoryDigest: inventoryDigest,
    mutationEvidenceDigest: mutation?.evidenceDigest ?? null,
    propertyEvidenceDigest: property?.evidenceDigest ?? null,
    requiredFuzzCaseCount,
    requiredRandomFuzzCaseCount,
    requiredExtremeVectorCount: requiredExtremeVectorDigests.length,
    extremeVectorInventoryDigest: digestValue(requiredExtremeVectorDigests),
    coverageEvidenceDigest: coverage?.evidenceDigest ?? null,
    coverageObjectiveDigest: coverageObjective.coverageObjectiveDigest,
    coverageThresholdDigest,
    modifiedLineCount,
    objectiveFailures: Object.freeze([...failures]),
  });
  const reviewContextDigest = digestValue(reviewContext);
  const reviewerRaw = await safeInvoke(
    config.reviewer,
    request(
      "reviewer",
      bindings,
      Object.freeze({ context: reviewContext, reviewContextDigest }),
    ),
  );
  const reviewer = parseReviewer(reviewerRaw, bindings, reviewContextDigest);
  if (reviewer === undefined) return rejection("AUTHORITY_REJECTED");
  if (reviewer.status !== "accepted") pushUnique(failures, "REVIEW_REJECTED");
  if (failures.length > 0) {
    return Object.freeze({
      status: "rejected" as const,
      code: failures[0] as VerificationGateFailureCode,
      failures: Object.freeze(failures),
    });
  }
  if (
    mutation === undefined ||
    property === undefined ||
    coverage === undefined
  ) {
    return rejection("AUTHORITY_REJECTED");
  }
  const material = Object.freeze({
    schema: "skizzles.verification-gate/receipt" as const,
    authorityId: config.authorityId,
    reviewerId: config.reviewer.id,
    taskId: bindings.taskId,
    taskEpochDigest: bindings.taskEpochDigest,
    requestDigest: bindings.requestDigest,
    repositoryId: bindings.repositoryId,
    rootIdentity: bindings.rootIdentity,
    treeDigest: bindings.treeDigest,
    baselineDigest: bindings.baselineDigest,
    candidateDigest: bindings.candidateDigest,
    candidateManifestDigest: bindings.candidateManifestDigest,
    specLockDigest: bindings.specLockDigest,
    baselineManifestDigest: bindings.baselineManifestDigest,
    candidateTestManifestDigest: task.candidateTestManifestDigest,
    sourceEvidenceDigest: source.evidenceDigest,
    compilerChainDigest: source.compilerChainDigest,
    complexityEvidenceDigest: source.complexityEvidenceDigest,
    changeAssuranceDigest: assurance["evidenceDigest"] as ReturnType<
      typeof digestValue
    >,
    taskWorktreeEvidenceDigest: task.evidenceDigest,
    worktreeViewDigest: task.viewDigest,
    artifactReceiptDigest: task.artifactReceiptDigest,
    physicalEvidenceDigest: physical["evidenceDigest"] as ReturnType<
      typeof digestValue
    >,
    originalTestReceiptDigest: original["evidenceDigest"] as ReturnType<
      typeof digestValue
    >,
    mutationInventoryDigest: inventoryDigest,
    mutationEvidenceDigest: mutation.evidenceDigest,
    propertyEvidenceDigest: property.evidenceDigest,
    seedScheduleDigest: property.seedScheduleDigest,
    requiredFuzzCaseCount,
    requiredRandomFuzzCaseCount,
    extremeVectorInventoryDigest: property.extremeVectorInventoryDigest,
    requiredExtremeVectorCount: requiredExtremeVectorDigests.length,
    coverageEvidenceDigest: coverage.evidenceDigest,
    coverageObjectiveDigest: coverageObjective.coverageObjectiveDigest,
    coverageThresholdDigest,
    reviewDigest: reviewer.reviewDigest,
    modifiedNodeCount: source.modifiedNodes.length,
    modifiedLineCount,
    modifiedBranchCount: source.modifiedNodes.reduce(
      (count, node) => count + node.branchIds.length,
      0,
    ),
    mutantCount: inventory.length,
    propertyCount: property.properties.length,
  });
  const receipt: VerificationGateReceipt = Object.freeze({
    ...material,
    receiptDigest: digestValue(material),
  });
  receipts.add(receipt);
  receiptOwners.set(receipt, Object.freeze({ owner, input }));
  return Object.freeze({ status: "accepted" as const, receipt });
}

function rejection(code: VerificationGateFailureCode): VerificationGateResult {
  return Object.freeze({
    status: "rejected" as const,
    code,
    failures: Object.freeze([code]),
  });
}

function pushUnique(
  failures: VerificationGateFailureCode[],
  code: VerificationGateFailureCode,
): void {
  if (!failures.includes(code)) failures.push(code);
}
