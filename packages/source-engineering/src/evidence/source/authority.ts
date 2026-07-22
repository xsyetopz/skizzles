import type { CapturedRecord, TemplateRecord } from "./authority-state.ts";
import { createCapture } from "./capture.ts";
import { parseConfig } from "./config.ts";
import type {
  SourceCaptureRecoveryResult,
  SourceEvidenceAuthority,
  SourceEvidenceCreationResult,
  TemplateEvidenceRecoveryResult,
} from "./contract.ts";
import { plainRecordShape } from "./primitives.ts";
import { createTemplateMaterializer } from "./template.ts";

export function createSourceEvidence(
  input: unknown,
): SourceEvidenceCreationResult {
  const config = parseConfig(input);
  if (config === undefined) {
    return Object.freeze({ status: "rejected", code: "INVALID_CONFIG" });
  }
  const captures = new WeakMap<object, CapturedRecord>();
  const templateReceipts = new WeakMap<object, TemplateRecord>();
  const evidence: SourceEvidenceAuthority = Object.freeze({
    capture: createCapture(config, captures),
    materializeTemplate: createTemplateMaterializer(
      config,
      captures,
      templateReceipts,
    ),
    recoverCapture: (value: unknown): SourceCaptureRecoveryResult => {
      if (!plainRecordShape(value)) {
        return Object.freeze({ status: "rejected", code: "FORGED_CAPTURE" });
      }
      const record = captures.get(value);
      if (record === undefined) {
        return Object.freeze({ status: "rejected", code: "FORGED_CAPTURE" });
      }
      return Object.freeze({
        status: "recovered",
        baselineBytes: record.baselineBytes,
      });
    },
    recoverTemplate: (value: unknown): TemplateEvidenceRecoveryResult => {
      if (!plainRecordShape(value)) {
        return Object.freeze({ status: "rejected", code: "TEMPLATE_REJECTED" });
      }
      const record = templateReceipts.get(value);
      if (record === undefined) {
        return Object.freeze({ status: "rejected", code: "TEMPLATE_REJECTED" });
      }
      return Object.freeze({
        status: "recovered",
        nodeSource: record.nodeSource,
      });
    },
  });
  return Object.freeze({ status: "created", evidence });
}
