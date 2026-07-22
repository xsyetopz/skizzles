import { types } from "node:util";
import { type Digest, digestBytes, digestText } from "../digest.ts";
import type { CompilerEvidenceReceipt } from "../evidence/compiler.ts";
import type {
  FaultFirstInspection,
  ParsedPolicyChange,
} from "../policy/contract.ts";
import { analyzeSourcePolicy, inspectFaultFirst } from "../policy/index.ts";
import type {
  SourceEngineeringAdvanceResult,
  SourceEngineeringArtifact,
  SourceEngineeringFailureCode,
  SourceEngineeringPolicyReceipt,
  SourceEngineeringTargetReceipt,
  SourceEngineeringTaskReceipt,
  SourceEngineeringVerifyResult,
} from "./contract.ts";
import { SourceEngineeringState } from "./cursor.ts";
import type {
  BatchState,
  BatchTargetState,
  EngineConfig,
} from "./workflow-state.ts";

const encoder = new TextEncoder();

type ValidationResult =
  | Extract<SourceEngineeringAdvanceResult, { status: "prepared" }>
  | Extract<SourceEngineeringAdvanceResult, { status: "rejected" }>;

export async function validateBatch(
  config: EngineConfig,
  state: SourceEngineeringState,
  batch: BatchState,
): Promise<ValidationResult> {
  try {
    return await validate(config, state, batch);
  } catch {
    return rejected("ARTIFACT_REJECTED");
  }
}

export function verifyPrepared(
  state: SourceEngineeringState,
  input: unknown,
): SourceEngineeringVerifyResult {
  try {
    const parsed = parseVerifyInput(input);
    if (parsed === undefined) return rejectedVerify("RECEIPT_FORGED");
    const prepared = state.consumePrepared(parsed.receipt);
    if (prepared === "replayed") return rejectedVerify("RECEIPT_REPLAYED");
    if (prepared === undefined) return rejectedVerify("RECEIPT_FORGED");
    if (
      prepared.receipt !== parsed.receipt ||
      prepared.artifacts !== parsed.artifacts ||
      parsed.artifacts.length !== prepared.artifacts.length
    ) {
      return rejectedVerify("ARTIFACT_REJECTED");
    }
    for (let index = 0; index < parsed.artifacts.length; index += 1) {
      const artifact = parsed.artifacts[index];
      const targetReceipt = prepared.receipt.targetReceipts[index];
      if (artifact === undefined || targetReceipt === undefined) {
        return rejectedVerify("ARTIFACT_REJECTED");
      }
      const expected = prepared.bytesByPath.get(artifact.path);
      if (
        expected === undefined ||
        prepared.artifacts[index] !== artifact ||
        targetReceipt.path !== artifact.path ||
        targetReceipt.candidateDigest !== artifact.digest
      ) {
        return rejectedVerify("ARTIFACT_REJECTED");
      }
      const first = artifact.readBytes();
      const second = artifact.readBytes();
      if (
        first === second ||
        !sameBytes(first, expected) ||
        !sameBytes(second, expected) ||
        artifact.byteLength !== expected.length ||
        artifact.digest !== digestBytes(first)
      ) {
        return rejectedVerify("ARTIFACT_REJECTED");
      }
    }
    if (
      aggregateTargetDigest(
        prepared.receipt.targetReceipts,
        "baselineDigest",
      ) !== prepared.receipt.baselineDigest ||
      aggregateTargetDigest(
        prepared.receipt.targetReceipts,
        "candidateDigest",
      ) !== prepared.receipt.candidateDigest ||
      validationDigestOf(prepared.receipt) !== prepared.receipt.validationDigest
    ) {
      return rejectedVerify("RECEIPT_FORGED");
    }
    return Object.freeze({
      status: "valid",
      candidateDigest: prepared.receipt.candidateDigest,
      provenanceDigest: prepared.receipt.provenanceDigest,
      validationDigest: prepared.receipt.validationDigest,
    });
  } catch {
    return rejectedVerify("RECEIPT_FORGED");
  }
}

async function validate(
  config: EngineConfig,
  state: SourceEngineeringState,
  batch: BatchState,
): Promise<ValidationResult> {
  const step = batch.steps[batch.step];
  if (step?.kind !== "validate" || step.ordinal !== batch.step) {
    return rejected("INVALID_INPUT");
  }
  const targets = [...batch.targets].sort((left, right) =>
    compareText(left.path, right.path),
  );
  if (!completeIndex(batch, targets)) return rejected("CONTEXT_DRIFTED");

  const preparedTargets: PreparedTarget[] = [];
  for (const target of targets) {
    const prepared = await prepareTarget(config, batch, target);
    if (prepared.status === "rejected") return prepared;
    preparedTargets.push(prepared);
  }

  const changes: ParsedPolicyChange[] = preparedTargets.map(
    ({ target, baseline, candidate }) =>
      Object.freeze({
        path: target.path,
        ownership: ownershipOf(batch, target.path),
        baselineText: baseline.text,
        baseline: baseline.sourceFile,
        candidateText: candidate.text,
        candidate: candidate.sourceFile,
      }),
  );
  const literalRegistry = config.literalRegistry.snapshot();
  const policyInput = Object.freeze({
    changes: Object.freeze(changes),
    faultFirst: batch.request.faultCases,
    literalRegistry,
  });
  const faultInspection = inspectFaultFirst(policyInput);
  const findings = analyzeSourcePolicy(policyInput);
  if (findings.length !== 0) return rejected("POLICY_REJECTED");

  const compilerTargets = Object.freeze(
    preparedTargets.map((prepared) =>
      Object.freeze({
        path: prepared.target.path,
        candidateDigest: prepared.candidateDigest,
        semanticDigest: prepared.candidateSemanticDigest,
        candidateBytes: prepared.formatterReceipt.formattedBytes,
      }),
    ),
  );
  const compilerReceipts: CompilerEvidenceReceipt[] = [];
  for (const prepared of preparedTargets) {
    const compiler = await batch.context.adapter.adapter.validateCandidate({
      requestDigest: batch.request.requestDigest,
      repositoryId: batch.request.repository.id,
      rootIdentity: batch.request.repository.rootIdentity,
      treeDigest: batch.request.repository.treeDigest,
      configDigest: batch.request.repository.configDigest,
      targetPath: prepared.target.path,
      candidateDigest: prepared.candidateDigest,
      semanticDigest: prepared.candidateSemanticDigest,
      targets: compilerTargets,
    });
    if (compiler.status !== "accepted") return rejected("COMPILER_REJECTED");
    compilerReceipts.push(compiler.receipt);
  }

  const targetReceipts = Object.freeze(
    preparedTargets.map(
      ({
        target,
        formatterReceipt,
        baselineDigest,
        candidateDigest,
        baselineSemanticDigest,
        candidateSemanticDigest,
      }) =>
        Object.freeze({
          path: target.path,
          baselineDigest,
          candidateDigest,
          baselineSemanticDigest,
          candidateSemanticDigest,
          changedDeclarations: Object.freeze(
            [...target.changedDeclarations].sort(compareText),
          ),
          templateReceipts: Object.freeze([...target.templateReceipts]),
          formatterReceipt,
        }) satisfies SourceEngineeringTargetReceipt,
    ),
  );
  const policyReceipt = createPolicyReceipt(
    changes,
    faultInspection,
    literalRegistry.registryDigest,
  );
  const compilerReceipt = Object.freeze({
    receipts: Object.freeze(compilerReceipts),
    receiptDigest: digestText(
      JSON.stringify(
        compilerReceipts.map(({ receiptDigest }) => receiptDigest),
      ),
    ),
  });
  const indexReceipt = Object.freeze({
    status: "indexed" as const,
    language: batch.context.adapter.language,
    advisory: true as const,
    indexDigest: batch.context.index.indexDigest,
  });
  const baselineDigest = aggregateTargetDigest(
    targetReceipts,
    "baselineDigest",
  );
  const candidateDigest = aggregateTargetDigest(
    targetReceipts,
    "candidateDigest",
  );
  const provenanceDigest = digestText(
    JSON.stringify({
      context: batch.context.receipt.receiptDigest,
      index: indexReceipt.indexDigest,
      compiler: compilerReceipt.receiptDigest,
      policy: policyReceipt.receiptDigest,
      targets: targetReceipts.map((receipt) => ({
        path: receipt.path,
        formatter: receipt.formatterReceipt.provenanceDigest,
        templates: receipt.templateReceipts.map(
          ({ receiptDigest }) => receiptDigest,
        ),
      })),
    }),
  );
  const receiptMaterial = {
    requestDigest: batch.request.requestDigest,
    contextDigest: batch.context.context.contextDigest,
    contextReceiptDigest: batch.context.receipt.receiptDigest,
    baselineDigest,
    candidateDigest,
    targetReceipts,
    indexReceipt,
    compilerReceipt,
    policyReceipt,
    provenanceDigest,
  };
  const receipt: SourceEngineeringTaskReceipt = Object.freeze({
    ...receiptMaterial,
    validationDigest: digestText(JSON.stringify(receiptMaterial)),
  });
  const bytesByPath = new Map<string, readonly number[]>();
  const artifacts = Object.freeze(
    preparedTargets.map(
      ({ target, candidateBytes, candidateDigest: digest }) => {
        const stored = Object.freeze([...candidateBytes]);
        bytesByPath.set(target.path, stored);
        const artifact: SourceEngineeringArtifact = Object.freeze({
          path: target.path,
          digest,
          byteLength: stored.length,
          readBytes: () => Uint8Array.from(stored),
        });
        return artifact;
      },
    ),
  );
  state.registerPrepared({
    artifacts,
    receipt,
    bytesByPath: new Map(bytesByPath),
  });
  batch.step += 1;
  return Object.freeze({ status: "prepared", artifacts, receipt });
}

interface PreparedTarget {
  readonly status: "prepared-target";
  readonly target: BatchTargetState;
  readonly formatterReceipt: NonNullable<BatchTargetState["formatterReceipt"]>;
  readonly baseline: import("../language/typescript-contract.ts").TypeScriptAstDocument;
  readonly candidate: import("../language/typescript-contract.ts").TypeScriptAstDocument;
  readonly baselineDigest: Digest;
  readonly candidateDigest: Digest;
  readonly baselineSemanticDigest: Digest;
  readonly candidateSemanticDigest: Digest;
  readonly candidateBytes: Uint8Array;
}

async function prepareTarget(
  config: EngineConfig,
  batch: BatchState,
  target: BatchTargetState,
): Promise<PreparedTarget | Extract<ValidationResult, { status: "rejected" }>> {
  if (target.formatterReceipt === null) return rejected("FORMATTER_REJECTED");
  const recovered = config.sourceEvidence.recoverCapture(target.capture);
  if (recovered.status !== "recovered") return rejected("CONTEXT_DRIFTED");
  const baselineBytes = Uint8Array.from(recovered.baselineBytes);
  if (!sameBytes(baselineBytes, target.baselineBytes))
    return rejected("CONTEXT_DRIFTED");
  const baselineText = decode(baselineBytes);
  const candidateBytes = encoder.encode(target.candidate.text);
  const baseline = await batch.context.adapter.adapter.parse({
    targetPath: target.path,
    sourceText: baselineText,
  });
  const candidate = await batch.context.adapter.adapter.parse({
    targetPath: target.path,
    sourceText: target.candidate.text,
  });
  if (baseline.status !== "parsed" || candidate.status !== "parsed") {
    return rejected("ARTIFACT_REJECTED");
  }
  const baselineDigest = digestBytes(baselineBytes);
  const candidateDigest = digestBytes(candidateBytes);
  const baselineSemanticDigest = batch.context.adapter.adapter.digestSemantics(
    baseline.parsed,
  );
  const candidateSemanticDigest = batch.context.adapter.adapter.digestSemantics(
    candidate.parsed,
  );
  if (
    baselineSemanticDigest === undefined ||
    candidateSemanticDigest === undefined
  ) {
    return rejected("ARTIFACT_REJECTED");
  }
  const formatter = target.formatterReceipt;
  if (
    target.capture.baselineDigest !== baselineDigest ||
    formatter.path !== target.path ||
    formatter.profileId !== batch.request.formatterId ||
    formatter.treeDigest !== batch.request.repository.treeDigest ||
    formatter.formattedDigest !== candidateDigest ||
    formatter.formattedSemanticDigest !== candidateSemanticDigest ||
    !sameBytes(formatter.formattedBytes, candidateBytes)
  ) {
    return rejected("FORMATTER_REJECTED");
  }
  const profile = batch.context.adapter.formatterProfiles.get(
    batch.request.formatterId,
  );
  if (
    profile === undefined ||
    formatter.tool !== profile.tool ||
    formatter.version !== profile.version ||
    formatter.configDigest !== profile.configDigest
  ) {
    return rejected("FORMATTER_REJECTED");
  }
  for (const template of target.templateReceipts) {
    const recoveredTemplate = config.sourceEvidence.recoverTemplate(template);
    if (
      recoveredTemplate.status !== "recovered" ||
      template.requestDigest !== batch.request.requestDigest ||
      template.repositoryId !== batch.request.repository.id ||
      template.rootIdentity !== batch.request.repository.rootIdentity ||
      template.treeDigest !== batch.request.repository.treeDigest ||
      template.configDigest !== batch.request.repository.configDigest ||
      template.path !== target.path ||
      digestText(recoveredTemplate.nodeSource) !== template.nodeSourceDigest
    ) {
      return rejected("TEMPLATE_REJECTED");
    }
  }
  return Object.freeze({
    status: "prepared-target",
    target,
    formatterReceipt: formatter,
    baseline: baseline.parsed,
    candidate: candidate.parsed,
    baselineDigest,
    candidateDigest,
    baselineSemanticDigest,
    candidateSemanticDigest,
    candidateBytes,
  });
}

function completeIndex(
  batch: BatchState,
  targets: readonly BatchTargetState[],
): boolean {
  const index = batch.context.index;
  return (
    Object.isFrozen(index) &&
    index.advisory &&
    index.repositoryId === batch.request.repository.id &&
    index.rootIdentity === batch.request.repository.rootIdentity &&
    index.treeDigest === batch.request.repository.treeDigest &&
    index.configDigest === batch.request.repository.configDigest &&
    targets.every(({ path }) => index.sourcePaths.includes(path))
  );
}

function ownershipOf(batch: BatchState, path: string): "production" | "test" {
  if (
    batch.request.faultCases.negativeTests.some(
      ({ testPath }) => testPath === path,
    )
  ) {
    return "test";
  }
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?tsx?$/u.test(
    path,
  )
    ? "test"
    : "production";
}

function createPolicyReceipt(
  changes: readonly ParsedPolicyChange[],
  faultInspection: FaultFirstInspection,
  literalRegistryDigest: Digest,
): SourceEngineeringPolicyReceipt {
  const changeSetDigest = digestText(
    JSON.stringify(
      changes.map(({ path, ownership, baselineText, candidateText }) => ({
        path,
        ownership,
        baselineDigest: baselineText === null ? null : digestText(baselineText),
        candidateDigest: digestText(candidateText),
      })),
    ),
  );
  return Object.freeze({
    findingCount: 0,
    changeSetDigest,
    observedNegativeTests: faultInspection.observedEvidence,
    faultEvidenceDigest: faultInspection.evidenceDigest,
    literalRegistryDigest,
    receiptDigest: digestText(
      JSON.stringify({
        changeSetDigest,
        observedNegativeTests: faultInspection.observedEvidence,
        faultEvidenceDigest: faultInspection.evidenceDigest,
        literalRegistryDigest,
      }),
    ),
  });
}

function aggregateTargetDigest(
  receipts: readonly SourceEngineeringTargetReceipt[],
  key: "baselineDigest" | "candidateDigest",
): Digest {
  return digestText(
    JSON.stringify(receipts.map((receipt) => [receipt.path, receipt[key]])),
  );
}

function validationDigestOf(receipt: SourceEngineeringTaskReceipt): Digest {
  const { validationDigest: _validationDigest, ...material } = receipt;
  return digestText(JSON.stringify(material));
}

function parseVerifyInput(value: unknown):
  | {
      readonly artifacts: readonly SourceEngineeringArtifact[];
      readonly receipt: SourceEngineeringTaskReceipt;
    }
  | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("artifacts") ||
    !keys.includes("receipt")
  )
    return;
  const artifacts = Object.getOwnPropertyDescriptor(value, "artifacts");
  const receipt = Object.getOwnPropertyDescriptor(value, "receipt");
  if (
    artifacts === undefined ||
    !("value" in artifacts) ||
    !Array.isArray(artifacts.value) ||
    receipt === undefined ||
    !("value" in receipt) ||
    typeof receipt.value !== "object" ||
    receipt.value === null
  )
    return;
  return { artifacts: artifacts.value, receipt: receipt.value };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejected(
  code: SourceEngineeringFailureCode,
): Extract<ValidationResult, { status: "rejected" }> {
  return Object.freeze({ status: "rejected", code });
}

function rejectedVerify(
  code: SourceEngineeringFailureCode,
): Extract<SourceEngineeringVerifyResult, { status: "rejected" }> {
  return Object.freeze({ status: "rejected", code });
}
