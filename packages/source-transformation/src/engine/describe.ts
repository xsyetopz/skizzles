import { digestText } from "../digest.ts";
import type {
  SourceEngineeringContext,
  SourceEngineeringContextReceipt,
  SourceEngineeringContextTarget,
  SourceEngineeringDescribeResult,
} from "./contract.ts";
import type { SourceEngineeringState } from "./cursor.ts";
import { parseDescribeRequest } from "./input.ts";
import type {
  ContextState,
  ContextTargetState,
  EngineConfig,
} from "./workflow-state.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function describeEngineering(
  config: EngineConfig,
  state: SourceEngineeringState,
  input: unknown,
): Promise<SourceEngineeringDescribeResult> {
  try {
    const request = parseDescribeRequest(input);
    if (request === undefined) return rejected("INVALID_INPUT");
    const adapter = config.languageAdapters.get(request.language);
    if (adapter === undefined) return rejected("UNSUPPORTED_LANGUAGE");
    if (
      !adapter.formatterProfiles.has(request.formatterId) ||
      request.targets.some(({ path }) => !adapter.adapter.supportsPath(path))
    ) {
      return rejected("CONTEXT_REJECTED");
    }
    const targets: ContextTargetState[] = [];
    for (const target of request.targets) {
      const captured = await config.sourceEvidence.capture({
        requestDigest: request.requestDigest,
        repositoryId: request.repository.id,
        rootIdentity: request.repository.rootIdentity,
        treeDigest: request.repository.treeDigest,
        configDigest: request.repository.configDigest,
        path: target.path,
        language: request.language,
      });
      if (captured.status !== "captured") {
        return rejected("CONTEXT_REJECTED");
      }
      const recovered = config.sourceEvidence.recoverCapture(captured.receipt);
      if (recovered.status !== "recovered") {
        return rejected("CONTEXT_REJECTED");
      }
      let text: string;
      try {
        text = decoder.decode(Uint8Array.from(recovered.baselineBytes));
      } catch {
        return rejected("CONTEXT_REJECTED");
      }
      const parsed = await adapter.adapter.parse({
        targetPath: target.path,
        sourceText: text,
      });
      if (parsed.status !== "parsed") return rejected("CONTEXT_REJECTED");
      targets.push(
        Object.freeze({
          path: target.path,
          capture: captured.receipt,
          baselineBytes: recovered.baselineBytes,
          baseline: parsed.parsed,
        }),
      );
    }
    const indexed = await adapter.adapter.buildSymbolIndex({
      repositoryId: request.repository.id,
      rootIdentity: request.repository.rootIdentity,
      treeDigest: request.repository.treeDigest,
      configDigest: request.repository.configDigest,
    });
    if (indexed.status !== "indexed") return rejected("CONTEXT_REJECTED");
    const templates = Object.freeze(
      [...config.templates.values()]
        .filter(({ language }) => language === request.language)
        .sort((left, right) => left.templateId.localeCompare(right.templateId))
        .map((template) =>
          Object.freeze({
            templateId: template.templateId,
            language: template.language,
            schemaText: template.schemaText,
            schemaDigest: template.schemaDigest,
            tool: template.tool,
            version: template.version,
          }),
        ),
    );
    const contextTargetList: SourceEngineeringContextTarget[] = [];
    for (const target of targets) {
      const baselineDigest = parseDigest(target.capture.baselineDigest);
      if (baselineDigest === undefined) return rejected("CONTEXT_REJECTED");
      const baselineSemanticDigest = adapter.adapter.digestSemantics(
        target.baseline,
      );
      const declarations = adapter.adapter.catalogDeclarations(target.baseline);
      if (baselineSemanticDigest === undefined || declarations === undefined) {
        return rejected("CONTEXT_REJECTED");
      }
      contextTargetList.push(
        Object.freeze({
          path: target.path,
          baselineDigest,
          baselineSemanticDigest,
          declarations: Object.freeze(
            declarations.map((declaration) =>
              Object.freeze({
                declarationKind: declaration.kind,
                name: declaration.name,
                nodeDigest: declaration.nodeDigest,
              }),
            ),
          ),
        }),
      );
    }
    const contextTargets = Object.freeze(contextTargetList);
    const contextMaterial = { templates, targets: contextTargets };
    const context: SourceEngineeringContext = Object.freeze({
      ...contextMaterial,
      contextDigest: digestText(JSON.stringify(contextMaterial)),
    });
    const targetSetDigest = digestText(
      JSON.stringify(contextTargets.map(({ path }) => path)),
    );
    const receiptMaterial = {
      contextDigest: context.contextDigest,
      requestDigest: request.requestDigest,
      repositoryId: request.repository.id,
      rootIdentity: request.repository.rootIdentity,
      treeDigest: request.repository.treeDigest,
      configDigest: request.repository.configDigest,
      targetSetDigest,
    };
    const receipt: SourceEngineeringContextReceipt = Object.freeze({
      ...receiptMaterial,
      receiptDigest: digestText(JSON.stringify(receiptMaterial)),
    });
    const contextState: ContextState = {
      request,
      adapter,
      context,
      receipt,
      targets: Object.freeze(targets),
      index: indexed.index,
      consumed: false,
    };
    state.registerContext(contextState);
    return Object.freeze({ status: "described", context, receipt });
  } catch {
    return rejected("CONTEXT_REJECTED");
  }
}

function parseDigest(value: string): `sha256:${string}` | undefined {
  if (!isDigest(value)) return;
  return value;
}

function isDigest(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function rejected(
  code: Extract<
    SourceEngineeringDescribeResult,
    { status: "rejected" }
  >["code"],
): SourceEngineeringDescribeResult {
  return Object.freeze({ status: "rejected", code });
}
