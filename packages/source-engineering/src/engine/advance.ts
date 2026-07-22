import { digestText } from "../digest.ts";
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
import {
  candidateSetDigestOf,
  cloneTarget,
  commitTargets,
  compileEpoch,
} from "./epoch.ts";
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
      astChanges: [],
      templateReceipts: [],
      formatterReceipt: null,
    };
  });
  const steps = createSteps(targets);
  const targetSetDigest = digestText(
    JSON.stringify(targets.map(({ path }) => path)),
  );
  const baselineCandidateSetDigest = candidateSetDigestOf(
    context.adapter,
    targets,
  );
  if (baselineCandidateSetDigest === undefined)
    return rejected("CONTEXT_DRIFTED");
  const batch: BatchState = {
    request,
    targets,
    steps,
    context,
    compilerReceipts: [],
    targetSetDigest,
    baselineCandidateSetDigest,
    candidateSetDigest: baselineCandidateSetDigest,
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
  if (step === undefined || step.kind === "validate") {
    return rejected("CURSOR_FORGED");
  }
  const failure =
    step.kind === "edit"
      ? await applyEditEpoch(config, batch, step.epoch)
      : await applyFormatEpoch(batch, step.epoch);
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
  const epochs = [
    ...new Set(
      targets.flatMap(({ operations }) => operations.map(({ epoch }) => epoch)),
    ),
  ].sort((left, right) => left - right);
  const steps: BatchStep[] = epochs.map((epoch, ordinal) =>
    Object.freeze({ kind: "edit", ordinal, epoch }),
  );
  const formatEpoch = (epochs.at(-1) ?? 0) + 1;
  steps.push(
    Object.freeze({
      kind: "format",
      ordinal: steps.length,
      epoch: formatEpoch,
    }),
  );
  steps.push(Object.freeze({ kind: "validate", ordinal: steps.length }));
  return Object.freeze(steps);
}

async function applyEditEpoch(
  config: EngineConfig,
  batch: BatchState,
  epoch: number | undefined,
): Promise<SourceEngineeringFailureCode | undefined> {
  if (epoch === undefined) return "EDIT_REJECTED";
  const candidates = batch.targets.map(cloneTarget);
  let operationCount = 0;
  for (const target of candidates) {
    const operations = target.operations.filter(
      (operation) => operation.epoch === epoch,
    );
    if (operations.length === 0) continue;
    operationCount += operations.length;
    const translatedOperations: TypeScriptNodeOperation[] = [];
    const templateReceipts: TemplateEvidenceReceipt[] = [];
    for (const operation of operations) {
      const translated = await translateOperation(
        config,
        batch.context.adapter,
        target,
        operation,
      );
      if (typeof translated === "string") return translated;
      translatedOperations.push(translated.operation);
      if (translated.receipt !== undefined) {
        templateReceipts.push(translated.receipt);
      }
    }
    const edited = await batch.context.adapter.adapter.editDeclarations({
      parsed: target.candidate,
      objective: batch.request.objective,
      operations: Object.freeze(translatedOperations),
    });
    if (
      edited.status !== "edited" ||
      edited.receipt.changes.length !== operations.length
    ) {
      return "EDIT_REJECTED";
    }
    const text = new TextDecoder().decode(
      Uint8Array.from(edited.receipt.candidateBytes),
    );
    const parsed = await batch.context.adapter.adapter.parse({
      targetPath: target.path,
      sourceText: text,
    });
    if (parsed.status !== "parsed") return "EDIT_REJECTED";
    target.candidate = parsed.parsed;
    target.astChanges.push(
      ...edited.receipt.changes.map((change) =>
        Object.freeze({ epoch, change }),
      ),
    );
    target.templateReceipts.push(...templateReceipts);
  }
  if (operationCount === 0) return "EDIT_REJECTED";
  const compiled = await compileEpoch(batch, candidates, epoch, "edit");
  if (compiled === undefined) return "COMPILER_REJECTED";
  commitTargets(batch.targets, candidates);
  batch.compilerReceipts.push(compiled.receipt);
  batch.candidateSetDigest = compiled.candidateSetDigest;
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

async function applyFormatEpoch(batch: BatchState, epoch: number | undefined) {
  if (epoch === undefined) return "FORMATTER_REJECTED";
  const profile = batch.context.adapter.formatterProfiles.get(
    batch.request.formatterId,
  );
  if (profile === undefined) return "FORMATTER_REJECTED";
  const candidates = batch.targets.map(cloneTarget);
  for (const target of candidates) {
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
  }
  const compiled = await compileEpoch(batch, candidates, epoch, "format");
  if (compiled === undefined) return "COMPILER_REJECTED";
  commitTargets(batch.targets, candidates);
  batch.compilerReceipts.push(compiled.receipt);
  batch.candidateSetDigest = compiled.candidateSetDigest;
  return completed();
}

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
    next.epoch === undefined
      ? { kind: next.kind, ordinal: next.ordinal }
      : {
          kind: next.kind,
          ordinal: next.ordinal,
          epoch: next.epoch,
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
