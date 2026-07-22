import type { TemplateEvidenceReceipt } from "../evidence/source.ts";
import type {
  SourceLanguageAdapterBindings,
  TypeScriptAstLanguageCapability,
} from "../language/typescript-contract.ts";
import type { TypeScriptNodeOperation } from "../typescript/contract.ts";
import type {
  SourceEngineeringAdvanceResult,
  SourceEngineeringCursor,
  SourceEngineeringFailureCode,
  SourceEngineeringNextStep,
  SourceEngineeringStartResult,
} from "./contract.ts";
import type { SourceEngineeringState } from "./cursor.ts";
import { objectValue, parseBatchRequest } from "./input.ts";
import type {
  BatchRequest,
  BatchState,
  BatchStep,
  BatchTargetState,
  ContextState,
  EngineConfig,
  EngineOperation,
  EngineSelector,
} from "./workflow-state.ts";

const consumedContexts = new WeakMap<SourceEngineeringState, WeakSet<object>>();

function startBatch(
  config: EngineConfig,
  state: SourceEngineeringState,
  input: unknown,
): SourceEngineeringStartResult {
  const request = parseBatchRequest(input);
  if (request === undefined) return rejected("INVALID_INPUT");
  const adapter = config.languageAdapters.get(request.language);
  if (adapter === undefined) return rejected("UNSUPPORTED_LANGUAGE");

  const seen = contextSet(state);
  if (seen.has(request.context)) return rejected("CONTEXT_REPLAYED");
  const context = state.consumeContext(request.context);
  if (context === undefined) return rejected("CONTEXT_FORGED");
  seen.add(request.context);
  if (
    adapter !== context.adapter ||
    !matchesContext(config, request, context)
  ) {
    return rejected("CONTEXT_DRIFTED");
  }

  const targets = request.targets.map((target, index): BatchTargetState => {
    const described = context.targets[index];
    if (described === undefined || described.path !== target.path) {
      throw new Error("matched context target disappeared");
    }
    return {
      path: target.path,
      capture: described.capture,
      baselineBytes: described.baselineBytes,
      baseline: described.baseline,
      operations: target.operations,
      candidate: described.baseline,
      changedDeclarations: [],
      templateReceipts: [],
      formatterReceipt: null,
    };
  });
  const steps = createSteps(targets);
  const batch: BatchState = {
    request,
    targets,
    steps,
    context,
    step: 0,
  };
  return ready(state.issueCursor(batch), steps[0]);
}

async function advanceBatch(
  config: EngineConfig,
  state: SourceEngineeringState,
  input: unknown,
): Promise<SourceEngineeringAdvanceResult> {
  const cursor = parseAdvanceInput(input);
  if (cursor === undefined) return rejected("INVALID_INPUT");
  const consumed = state.consumeCursor(cursor);
  if (consumed === "replayed") return rejected("CURSOR_REPLAYED");
  if (consumed === undefined) return rejected("CURSOR_FORGED");

  const { batch } = consumed;
  const step = batch.steps[batch.step];
  const location = step === undefined ? undefined : locateStep(batch, step);
  if (
    step === undefined ||
    location === undefined ||
    step.kind === "validate"
  ) {
    return rejected("CURSOR_FORGED");
  }
  const target = batch.targets[location.targetIndex];
  if (target === undefined) return rejected("CURSOR_FORGED");

  const failure =
    step.kind === "edit"
      ? await applyEdit(config, batch, target, location.operationIndex)
      : await applyFormat(batch, target);
  if (failure !== undefined) return rejected(failure);

  batch.step += 1;
  const next = batch.steps[batch.step];
  if (next === undefined) return rejected("CURSOR_FORGED");
  return ready(state.issueCursor(batch), next);
}

function matchesContext(
  config: EngineConfig,
  request: BatchRequest,
  context: ContextState,
): boolean {
  const described = context.request;
  const repository = request.repository;
  const describedRepository = described.repository;
  return (
    request.contextDigest === context.context.contextDigest &&
    request.contextDigest === context.receipt.contextDigest &&
    request.requestDigest === described.requestDigest &&
    request.requestDigest === context.receipt.requestDigest &&
    repository.id === describedRepository.id &&
    repository.id === context.receipt.repositoryId &&
    repository.rootIdentity === describedRepository.rootIdentity &&
    repository.rootIdentity === context.receipt.rootIdentity &&
    repository.treeDigest === describedRepository.treeDigest &&
    repository.treeDigest === context.receipt.treeDigest &&
    repository.configDigest === describedRepository.configDigest &&
    repository.configDigest === context.receipt.configDigest &&
    request.objective === described.objective &&
    request.formatterId === described.formatterId &&
    request.language === described.language &&
    request.language === context.adapter.language &&
    context.adapter.formatterProfiles.has(request.formatterId) &&
    samePaths(request.targets, described.targets) &&
    samePaths(request.targets, context.targets) &&
    sameTemplates(config, context)
  );
}

function samePaths(
  left: readonly { readonly path: string }[],
  right: readonly { readonly path: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(({ path }, index) => path === right[index]?.path)
  );
}

function sameTemplates(config: EngineConfig, context: ContextState): boolean {
  const configured = [...config.templates.values()]
    .filter(({ language }) => language === context.request.language)
    .sort((left, right) => left.templateId.localeCompare(right.templateId));
  const described = [...context.context.templates].sort((left, right) =>
    left.templateId.localeCompare(right.templateId),
  );
  return (
    configured.length === described.length &&
    configured.every((template, index) => {
      const actual = described[index];
      return (
        actual !== undefined &&
        template.templateId === actual.templateId &&
        template.language === actual.language &&
        template.schemaText === actual.schemaText &&
        template.schemaDigest === actual.schemaDigest &&
        template.tool === actual.tool &&
        template.version === actual.version
      );
    })
  );
}

function createSteps(
  targets: readonly BatchTargetState[],
): readonly BatchStep[] {
  const steps: BatchStep[] = [];
  for (const target of targets) {
    for (
      let operationIndex = 0;
      operationIndex < target.operations.length;
      operationIndex += 1
    ) {
      steps.push(
        Object.freeze({
          kind: "edit",
          ordinal: steps.length,
          operationIndex,
        }),
      );
    }
    steps.push(Object.freeze({ kind: "format", ordinal: steps.length }));
  }
  steps.push(Object.freeze({ kind: "validate", ordinal: steps.length }));
  return Object.freeze(steps);
}

function locateStep(batch: BatchState, expected: BatchStep) {
  let ordinal = 0;
  for (
    let targetIndex = 0;
    targetIndex < batch.targets.length;
    targetIndex += 1
  ) {
    const target = batch.targets[targetIndex];
    if (target === undefined) return missingLocation();
    for (
      let operationIndex = 0;
      operationIndex < target.operations.length;
      operationIndex += 1
    ) {
      if (ordinal === expected.ordinal && expected.kind === "edit") {
        return { targetIndex, operationIndex };
      }
      ordinal += 1;
    }
    if (ordinal === expected.ordinal && expected.kind === "format") {
      return { targetIndex, operationIndex: -1 };
    }
    ordinal += 1;
  }
  return missingLocation();
}

async function applyEdit(
  config: EngineConfig,
  batch: BatchState,
  target: BatchTargetState,
  operationIndex: number,
): Promise<SourceEngineeringFailureCode | undefined> {
  const operation = target.operations[operationIndex];
  if (operation === undefined) return "EDIT_REJECTED";
  const translated = await translateOperation(
    config,
    batch.context.adapter,
    target,
    operation,
  );
  if (typeof translated === "string") return translated;
  const edited = await batch.context.adapter.adapter.editDeclarations({
    parsed: target.candidate,
    objective: batch.request.objective,
    operations: Object.freeze([translated.operation]),
  });
  if (edited.status !== "edited") return "EDIT_REJECTED";
  const text = new TextDecoder().decode(
    Uint8Array.from(edited.receipt.candidateBytes),
  );
  const parsed = await batch.context.adapter.adapter.parse({
    targetPath: target.path,
    sourceText: text,
  });
  if (parsed.status !== "parsed") return "EDIT_REJECTED";
  target.candidate = parsed.parsed;
  target.changedDeclarations.push(...edited.receipt.changedNodeDigests);
  if (translated.receipt !== undefined)
    target.templateReceipts.push(translated.receipt);
  return completed();
}

async function translateOperation(
  config: EngineConfig,
  adapter: SourceLanguageAdapterBindings,
  target: BatchTargetState,
  operation: EngineOperation,
): Promise<
  | Readonly<{
      operation: TypeScriptNodeOperation;
      receipt?: TemplateEvidenceReceipt;
    }>
  | "EDIT_REJECTED"
  | "TEMPLATE_REJECTED"
> {
  if (operation.kind === "delete") {
    if (
      !adapter.adapter.supportsDeclarationKind(
        operation.selector.declarationKind,
      )
    ) {
      return "EDIT_REJECTED";
    }
    return Object.freeze({
      operation: Object.freeze({
        kind: "delete",
        selector: selector(adapter.adapter, operation.selector),
      }),
    });
  }
  const template = config.templates.get(operation.templateId);
  if (template === undefined || template.language !== target.capture.language) {
    return "TEMPLATE_REJECTED";
  }
  const materialized = await config.sourceEvidence.materializeTemplate(
    Object.freeze({
      capture: target.capture,
      templateId: operation.templateId,
      nodeSource: operation.nodeSource,
    }),
  );
  if (materialized.status !== "materialized") return "TEMPLATE_REJECTED";
  const recovered = config.sourceEvidence.recoverTemplate(materialized.receipt);
  if (
    recovered.status !== "recovered" ||
    recovered.nodeSource !== operation.nodeSource ||
    materialized.receipt.schemaDigest !== template.schemaDigest ||
    materialized.receipt.tool !== template.tool ||
    materialized.receipt.toolVersion !== template.version
  ) {
    return "TEMPLATE_REJECTED";
  }
  const anchor =
    operation.kind === "replace" ? operation.selector : operation.anchor;
  const kind =
    operation.kind === "replace"
      ? "replace"
      : operation.position === "before"
        ? "insert-before"
        : "insert-after";
  if (!adapter.adapter.supportsDeclarationKind(anchor.declarationKind)) {
    return "EDIT_REJECTED";
  }
  return Object.freeze({
    operation: Object.freeze({
      kind,
      selector: selector(adapter.adapter, anchor),
      source: recovered.nodeSource,
    }),
    receipt: materialized.receipt,
  });
}

function selector(
  adapter: TypeScriptAstLanguageCapability,
  value: EngineSelector,
) {
  if (!adapter.supportsDeclarationKind(value.declarationKind)) {
    throw new Error("language adapter rejected declaration selector");
  }
  return Object.freeze({
    kind: value.declarationKind,
    name: value.name,
    expectedNodeDigest: value.expectedNodeDigest,
  });
}

async function applyFormat(batch: BatchState, target: BatchTargetState) {
  const profile = batch.context.adapter.formatterProfiles.get(
    batch.request.formatterId,
  );
  if (profile === undefined) return "FORMATTER_REJECTED";
  const formatted = await batch.context.adapter.adapter.formatCandidate({
    candidate: target.candidate,
    treeDigest: batch.request.repository.treeDigest,
    profileId: profile.profileId,
  });
  if (formatted.status !== "formatted") return "FORMATTER_REJECTED";
  const text = new TextDecoder().decode(
    Uint8Array.from(formatted.receipt.formattedBytes),
  );
  const parsed = await batch.context.adapter.adapter.parse({
    targetPath: target.path,
    sourceText: text,
  });
  if (parsed.status !== "parsed") return "FORMATTER_REJECTED";
  target.candidate = parsed.parsed;
  target.formatterReceipt = formatted.receipt;
  return completed();
}

function missingLocation(): undefined {}

function completed(): undefined {}

function parseAdvanceInput(value: unknown): object | undefined {
  if (!Object.isFrozen(value)) return;
  const input = objectValue(value);
  if (input === undefined) return;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 1 || keys[0] !== "cursor") return;
  const descriptor = Object.getOwnPropertyDescriptor(input, "cursor");
  if (descriptor === undefined || !("value" in descriptor)) return;
  return objectValue(descriptor.value);
}

function contextSet(state: SourceEngineeringState): WeakSet<object> {
  const existing = consumedContexts.get(state);
  if (existing !== undefined) return existing;
  const created = new WeakSet<object>();
  consumedContexts.set(state, created);
  return created;
}

function ready(
  cursor: SourceEngineeringCursor,
  next: BatchStep | undefined,
): SourceEngineeringStartResult {
  if (next === undefined) return rejected("CURSOR_FORGED");
  const publicNext: SourceEngineeringNextStep = Object.freeze(
    next.operationIndex === undefined
      ? { kind: next.kind, ordinal: next.ordinal }
      : {
          kind: next.kind,
          ordinal: next.ordinal,
          operationIndex: next.operationIndex,
        },
  );
  return Object.freeze({ status: "ready", cursor, next: publicNext });
}

function rejected(code: SourceEngineeringFailureCode): Readonly<{
  status: "rejected";
  code: SourceEngineeringFailureCode;
}> {
  return Object.freeze({ status: "rejected", code });
}

export { advanceBatch, startBatch };
