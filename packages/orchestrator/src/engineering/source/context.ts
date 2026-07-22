import { type Digest, digestValue } from "../../digest.ts";
import type {
  EngineeringContext,
  EngineeringDeclarationKind,
  EngineeringWorkflowConfig,
  SourceEngineeringPort,
} from "../contract.ts";
import type { ParsedDescribeInput } from "../input/describe.ts";
import {
  isFrozenOpaque,
  snapshotArray,
  snapshotRecord,
} from "../session/snapshot.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumEntries = 4096;
const maximumSchemaBytes = 262_144;

export interface SourceContextReceipt {
  readonly receiptDigest: Digest;
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: Digest;
  readonly configDigest: Digest;
  readonly targetSetDigest: Digest;
  readonly contextDigest: Digest;
}

export type SourceDescribeResult =
  | {
      readonly status: "described";
      readonly context: EngineeringContext;
      readonly receipt: SourceContextReceipt;
      readonly receiptReference: object;
    }
  | {
      readonly status: "rejected";
      readonly code: "SOURCE_ENGINEERING_REJECTED";
    };

export function sourceRepository(
  config: EngineeringWorkflowConfig,
  repository: ParsedDescribeInput["repository"],
) {
  return Object.freeze({
    id: repository.repositoryId,
    rootIdentity: config.causal.publicationIdentity.rootIdentity,
    treeDigest: repository.treeDigest,
    configDigest: repository.contextDigest,
  });
}

export function sourceContextMatches(
  result: Extract<SourceDescribeResult, { status: "described" }>,
  input: ParsedDescribeInput,
  config: EngineeringWorkflowConfig,
): boolean {
  const expectedTargetSet = digestValue(input.targets);
  return (
    result.receipt.requestDigest === input.request.intentDigest &&
    result.receipt.repositoryId === input.repository.repositoryId &&
    result.receipt.rootIdentity ===
      config.causal.publicationIdentity.rootIdentity &&
    result.receipt.treeDigest === input.repository.treeDigest &&
    result.receipt.configDigest === input.repository.contextDigest &&
    result.receipt.targetSetDigest === expectedTargetSet &&
    result.context.templates.every(
      ({ language }) => language === input.profile.language,
    ) &&
    result.context.targets.length === input.targets.length &&
    result.context.targets.every(
      (target, index) => target.path === input.targets[index],
    )
  );
}

export async function describeSourceEngineering(
  engine: SourceEngineeringPort,
  input: unknown,
): Promise<SourceDescribeResult> {
  let raw: unknown;
  try {
    raw = await engine.describe(input);
  } catch {
    return rejected();
  }
  const value = snapshotRecord(raw, ["status", "context", "receipt"]);
  const context = parseContext(value?.["context"]);
  const receipt = parseContextReceipt(value?.["receipt"]);
  if (
    value === undefined ||
    value["status"] !== "described" ||
    context === undefined ||
    receipt === undefined ||
    context.contextDigest !== receipt.contextDigest ||
    !isFrozenOpaque(value["receipt"])
  ) {
    return rejected();
  }
  return {
    status: "described",
    context,
    receipt,
    receiptReference: value["receipt"],
  };
}

function parseContext(input: unknown): EngineeringContext | undefined {
  const value = snapshotRecord(input, [
    "contextDigest",
    "templates",
    "targets",
  ]);
  const templateValues = snapshotArray(value?.["templates"], maximumEntries);
  const targetValues = snapshotArray(value?.["targets"], maximumEntries);
  if (
    value === undefined ||
    !validDigest(value["contextDigest"]) ||
    templateValues === undefined ||
    targetValues === undefined ||
    targetValues.length === 0
  ) {
    return;
  }
  const templates: EngineeringContext["templates"][number][] = [];
  for (const raw of templateValues) {
    const template = snapshotRecord(raw, [
      "templateId",
      "language",
      "schemaText",
      "schemaDigest",
      "tool",
      "version",
    ]);
    if (
      !(
        template !== undefined &&
        validIdentity(template["templateId"]) &&
        validIdentity(template["language"]) &&
        typeof template["schemaText"] === "string" &&
        Buffer.byteLength(template["schemaText"]) <= maximumSchemaBytes &&
        validDigest(template["schemaDigest"]) &&
        validIdentity(template["tool"]) &&
        validIdentity(template["version"])
      )
    ) {
      return;
    }
    templates.push(
      Object.freeze({
        templateId: template["templateId"],
        language: template["language"],
        schemaText: template["schemaText"],
        schemaDigest: template["schemaDigest"],
        tool: template["tool"],
        version: template["version"],
      }),
    );
  }
  const targets: EngineeringContext["targets"][number][] = [];
  for (const raw of targetValues) {
    const target = parseTarget(raw);
    if (target === undefined) return;
    targets.push(target);
  }
  return Object.freeze({
    contextDigest: value["contextDigest"],
    templates: Object.freeze(templates),
    targets: Object.freeze(targets),
  });
}

function parseTarget(
  input: unknown,
): EngineeringContext["targets"][number] | undefined {
  const target = snapshotRecord(input, [
    "path",
    "baselineDigest",
    "baselineSemanticDigest",
    "declarations",
  ]);
  const declarationValues = snapshotArray(
    target?.["declarations"],
    maximumEntries,
  );
  if (
    target === undefined ||
    typeof target["path"] !== "string" ||
    target["path"].length === 0 ||
    !validDigest(target["baselineDigest"]) ||
    !validDigest(target["baselineSemanticDigest"]) ||
    declarationValues === undefined
  ) {
    return;
  }
  const declarations: EngineeringContext["targets"][number]["declarations"][number][] =
    [];
  for (const raw of declarationValues) {
    const declaration = snapshotRecord(raw, [
      "declarationKind",
      "name",
      "nodeDigest",
    ]);
    if (
      declaration === undefined ||
      !validDeclarationKind(declaration["declarationKind"]) ||
      !validIdentity(declaration["name"]) ||
      !validDigest(declaration["nodeDigest"])
    ) {
      return;
    }
    declarations.push(
      Object.freeze({
        declarationKind: declaration["declarationKind"],
        name: declaration["name"],
        nodeDigest: declaration["nodeDigest"],
      }),
    );
  }
  return Object.freeze({
    path: target["path"],
    baselineDigest: target["baselineDigest"],
    baselineSemanticDigest: target["baselineSemanticDigest"],
    declarations: Object.freeze(declarations),
  });
}

function parseContextReceipt(input: unknown): SourceContextReceipt | undefined {
  if (!isFrozenOpaque(input)) return;
  const value = snapshotRecord(input, [
    "receiptDigest",
    "requestDigest",
    "repositoryId",
    "rootIdentity",
    "treeDigest",
    "configDigest",
    "targetSetDigest",
    "contextDigest",
  ]);
  if (
    !(
      value !== undefined &&
      validDigest(value["receiptDigest"]) &&
      validDigest(value["requestDigest"]) &&
      validIdentity(value["repositoryId"]) &&
      validIdentity(value["rootIdentity"]) &&
      validDigest(value["treeDigest"]) &&
      validDigest(value["configDigest"]) &&
      validDigest(value["targetSetDigest"]) &&
      validDigest(value["contextDigest"])
    )
  ) {
    return;
  }
  return Object.freeze({
    receiptDigest: value["receiptDigest"],
    requestDigest: value["requestDigest"],
    repositoryId: value["repositoryId"],
    rootIdentity: value["rootIdentity"],
    treeDigest: value["treeDigest"],
    configDigest: value["configDigest"],
    targetSetDigest: value["targetSetDigest"],
    contextDigest: value["contextDigest"],
  });
}

function validDeclarationKind(
  value: unknown,
): value is EngineeringDeclarationKind {
  return (
    value === "class" ||
    value === "enum" ||
    value === "function" ||
    value === "interface" ||
    value === "type"
  );
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\0")
  );
}

function rejected(): SourceDescribeResult {
  return { status: "rejected", code: "SOURCE_ENGINEERING_REJECTED" };
}
