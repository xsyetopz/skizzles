import type {
  CapturedRecord,
  ParsedConfig,
  TemplateRecord,
} from "./authority-state.ts";
import type {
  TemplateEvidenceReceipt,
  TemplateEvidenceResult,
} from "./contract.ts";
import {
  parseTemplateProvenance,
  parseTemplateRequest,
  sameTemplateBinding,
} from "./parse.ts";
import { digestText, digestValue, rejected } from "./primitives.ts";

type TemplateRequest = Parameters<typeof sameTemplateBinding>[1] & {
  readonly nodeSource: string;
};

export function createTemplateMaterializer(
  config: ParsedConfig,
  captures: WeakMap<object, CapturedRecord>,
  templateReceipts: WeakMap<object, TemplateRecord>,
): (value: unknown) => Promise<TemplateEvidenceResult> {
  return async (value: unknown): Promise<TemplateEvidenceResult> => {
    const parsed = parseTemplateRequest(value);
    if (parsed === undefined) return rejected("INVALID_INPUT");
    const captured = captures.get(parsed.capture);
    if (captured === undefined) return rejected("FORGED_CAPTURE");
    const registration = config.templates.get(parsed.templateId);
    if (
      registration === undefined ||
      registration.language !== captured.receipt.language
    ) {
      return rejected("TEMPLATE_REJECTED");
    }
    const nodeSourceDigest = digestText(parsed.nodeSource);
    const request: TemplateRequest = Object.freeze({
      requestDigest: captured.receipt.requestDigest,
      repositoryId: captured.receipt.repositoryId,
      rootIdentity: captured.receipt.rootIdentity,
      treeDigest: captured.receipt.treeDigest,
      configDigest: captured.receipt.configDigest,
      path: captured.receipt.path,
      language: captured.receipt.language,
      baselineDigest: captured.receipt.baselineDigest,
      templateId: registration.id,
      nodeSourceDigest,
      nodeSource: parsed.nodeSource,
    });
    const provenance = await materialize(config, request);
    if (provenance === undefined) return rejected("TEMPLATE_REJECTED");
    if (!sameTemplateBinding(provenance, request)) {
      return rejected("TEMPLATE_STALE");
    }
    if (provenance.contentDigest !== nodeSourceDigest) {
      return rejected("TEMPLATE_REJECTED");
    }
    const receipt = createReceipt(captured, request, provenance);
    templateReceipts.set(receipt, { receipt, nodeSource: parsed.nodeSource });
    return Object.freeze({ status: "materialized", receipt });
  };
}

async function materialize(
  config: ParsedConfig,
  request: TemplateRequest,
): Promise<ReturnType<typeof parseTemplateProvenance>> {
  try {
    return parseTemplateProvenance(await config.materializeTemplate(request));
  } catch {
    return undefined;
  }
}

function createReceipt(
  captured: CapturedRecord,
  request: TemplateRequest,
  provenance: NonNullable<ReturnType<typeof parseTemplateProvenance>>,
): TemplateEvidenceReceipt {
  const material = Object.freeze({
    captureReceiptDigest: captured.receipt.receiptDigest,
    requestDigest: request.requestDigest,
    repositoryId: request.repositoryId,
    rootIdentity: request.rootIdentity,
    treeDigest: request.treeDigest,
    configDigest: request.configDigest,
    path: request.path,
    language: request.language,
    baselineDigest: request.baselineDigest,
    templateId: request.templateId,
    templateDigest: provenance.templateDigest,
    tool: provenance.tool,
    toolVersion: provenance.toolVersion,
    contentDigest: provenance.contentDigest,
    schemaDigest: provenance.schemaDigest,
    nodeSourceDigest: request.nodeSourceDigest,
  });
  return Object.freeze({
    ...material,
    receiptDigest: digestValue(material),
  });
}
