import type {
  ChangeAssurance,
  ChangeAssuranceCreationResult,
  ChangeAssuranceExtension,
  ChangeAssuranceExtensionReceipt,
  ChangeAssuranceReceipt,
  ChangeAssuranceResult,
} from "./contract.ts";
import { assuranceDomains, declarationBindings } from "./declaration.ts";
import { digestBytes, digestValue, isDigest } from "./digest.ts";
import { invokeExtension, isChangeAssuranceExtension } from "./extension.ts";
import { parseAssessmentInput } from "./input.ts";

const assurances = new WeakSet<object>();
const receipts = new WeakSet<object>();
const receiptBindings = new WeakMap<
  object,
  Readonly<{ owner: object; assessmentDigest: ReturnType<typeof digestValue> }>
>();

export function createChangeAssurance(
  input: unknown,
): ChangeAssuranceCreationResult {
  let extensions: ReturnType<typeof parseConfig>;
  try {
    extensions = parseConfig(input);
  } catch {
    extensions = undefined;
  }
  if (extensions === undefined)
    return { status: "rejected", code: "INVALID_CONFIG" };
  const owner = Object.freeze({});
  const assurance: ChangeAssurance = Object.freeze({
    assess: async (assessment: unknown) =>
      await assess(owner, extensions, assessment),
    verify: (verification: unknown) => verify(owner, verification),
  });
  assurances.add(assurance);
  return { status: "created", changeAssurance: assurance };
}

export function isChangeAssurance(input: unknown): input is ChangeAssurance {
  return typeof input === "object" && input !== null && assurances.has(input);
}

export function isChangeAssuranceReceipt(
  input: unknown,
): input is ChangeAssuranceReceipt {
  return typeof input === "object" && input !== null && receipts.has(input);
}

async function assess(
  owner: object,
  extensions: readonly ChangeAssuranceExtension[],
  raw: unknown,
): Promise<ChangeAssuranceResult> {
  let input: ReturnType<typeof parseAssessmentInput>;
  try {
    input = parseAssessmentInput(raw);
  } catch {
    input = undefined;
  }
  if (input === undefined) return { status: "rejected", code: "INVALID_INPUT" };
  const declaration = input.declaration;
  const bindings = declarationBindings(declaration);
  if (
    bindings === undefined ||
    declaration.requestDigest !== input.requestDigest ||
    declaration.repositoryId !== input.repositoryId
  )
    return { status: "rejected", code: "DECLARATION_REJECTED" };
  const targetMaterial = input.targets.map((target) =>
    Object.freeze({
      path: target.path,
      operation: target.operation,
      baselineDigest:
        target.baselineBytes === null
          ? null
          : digestBytes(Uint8Array.from(target.baselineBytes)),
      candidateDigest:
        target.candidateBytes === null
          ? null
          : digestBytes(Uint8Array.from(target.candidateBytes)),
    }),
  );
  const declarationTargets = bindings.targets;
  if (
    declaration.targetSetDigest !== digestValue(declarationTargets) ||
    declarationTargets.length !== input.targets.length ||
    declarationTargets.some(
      (target, index) =>
        target.path !== input.targets[index]?.path ||
        target.operation !== input.targets[index]?.operation,
    )
  )
    return { status: "rejected", code: "TARGET_BINDING_REJECTED" };
  const extensionReceipts: ChangeAssuranceExtensionReceipt[] = [];
  for (const extension of extensions) {
    const result = await invokeExtension(
      extension,
      Object.freeze({
        requestDigest: input.requestDigest,
        repositoryId: input.repositoryId,
        treeDigest: input.treeDigest,
        baselineDigest: input.baselineDigest,
        declarationDigest: declaration.declarationDigest,
        domain: extension.domain,
        plan: bindings.plans[extension.domain],
        targets: input.targets,
      }),
    );
    if (result.status !== "accepted" || !isDigest(result.evidenceDigest)) {
      return { status: "rejected", code: rejectionFor(extension.domain) };
    }
    extensionReceipts.push(
      Object.freeze({
        domain: extension.domain,
        extensionId: extension.id,
        extensionVersion: extension.version,
        evidenceDigest: result.evidenceDigest,
      }),
    );
  }
  const material = Object.freeze({
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    treeDigest: input.treeDigest,
    baselineDigest: input.baselineDigest,
    targetSetDigest: digestValue(targetMaterial),
    candidateDigest: digestValue(
      targetMaterial.map(({ path, operation, candidateDigest }) => ({
        path,
        operation,
        candidateDigest,
      })),
    ),
    declarationDigest: declaration.declarationDigest,
    extensionReceipts: Object.freeze(extensionReceipts),
  });
  const receipt: ChangeAssuranceReceipt = Object.freeze({
    ...material,
    receiptDigest: digestValue(material),
  });
  receipts.add(receipt);
  receiptBindings.set(
    receipt,
    Object.freeze({ owner, assessmentDigest: assessmentDigest(input) }),
  );
  return { status: "accepted", receipt };
}

function rejectionFor(
  domain: ChangeAssuranceExtension["domain"],
): Extract<ChangeAssuranceResult, { status: "rejected" }>["code"] {
  if (domain === "middleware-security") return "MIDDLEWARE_SECURITY_REJECTED";
  if (domain === "migration-configuration-secrets") {
    return "MIGRATION_CONFIGURATION_SECRETS_REJECTED";
  }
  if (domain === "performance") return "PERFORMANCE_REJECTED";
  return "SUPPLY_CHAIN_REJECTED";
}

function verify(owner: object, raw: unknown): boolean {
  try {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      types.isProxy(raw) ||
      !Object.isFrozen(raw) ||
      Reflect.ownKeys(raw).length !== 2
    )
      return false;
    const receiptDescriptor = Object.getOwnPropertyDescriptor(raw, "receipt");
    const assessmentDescriptor = Object.getOwnPropertyDescriptor(
      raw,
      "assessment",
    );
    if (
      receiptDescriptor === undefined ||
      !("value" in receiptDescriptor) ||
      assessmentDescriptor === undefined ||
      !("value" in assessmentDescriptor) ||
      !isChangeAssuranceReceipt(receiptDescriptor.value)
    )
      return false;
    const binding = receiptBindings.get(receiptDescriptor.value);
    const assessment = parseAssessmentInput(assessmentDescriptor.value);
    if (
      binding === undefined ||
      binding.owner !== owner ||
      assessment === undefined ||
      binding.assessmentDigest !== assessmentDigest(assessment)
    )
      return false;
    const receipt = receiptDescriptor.value;
    const { receiptDigest: _receiptDigest, ...material } = receipt;
    return receipt.receiptDigest === digestValue(material);
  } catch {
    return false;
  }
}

function assessmentDigest(
  input: NonNullable<ReturnType<typeof parseAssessmentInput>>,
): ReturnType<typeof digestValue> {
  return digestValue({
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    treeDigest: input.treeDigest,
    baselineDigest: input.baselineDigest,
    declarationDigest: input.declaration.declarationDigest,
    targets: input.targets.map((target) =>
      Object.freeze({
        path: target.path,
        operation: target.operation,
        baselineDigest:
          target.baselineBytes === null
            ? null
            : digestBytes(Uint8Array.from(target.baselineBytes)),
        candidateDigest:
          target.candidateBytes === null
            ? null
            : digestBytes(Uint8Array.from(target.candidateBytes)),
      }),
    ),
  });
}

function parseConfig(
  input: unknown,
): readonly ChangeAssuranceExtension[] | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    !Object.isFrozen(input) ||
    Reflect.ownKeys(input).length !== 1 ||
    !Reflect.ownKeys(input).includes("extensions")
  )
    return;
  const descriptor = Object.getOwnPropertyDescriptor(input, "extensions");
  if (descriptor === undefined || !("value" in descriptor)) return;
  const raw = descriptor.value;
  if (
    !(Array.isArray(raw) && Object.isFrozen(raw)) ||
    raw.length !== assuranceDomains.length
  )
    return;
  const extensions: ChangeAssuranceExtension[] = [];
  for (const domain of assuranceDomains) {
    const extension = raw.find(
      (candidate) =>
        isChangeAssuranceExtension(candidate) && candidate.domain === domain,
    );
    if (extension === undefined || extensions.includes(extension)) return;
    extensions.push(extension);
  }
  return Object.freeze(extensions);
}

import { types } from "node:util";
