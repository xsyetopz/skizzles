import type { ParsedConfig, TemplateRegistration } from "./authority-state.ts";
import {
  denseDataArray,
  IDENTIFIER_PATTERN,
  plainRecord,
} from "./primitives.ts";

export function parseConfig(input: unknown): ParsedConfig | undefined {
  if (
    !(
      plainRecord(input, [
        "sourceCaptureAuthority",
        "templateAuthority",
        "templates",
      ]) &&
      plainRecord(input.sourceCaptureAuthority, ["capture"]) &&
      plainRecord(input.templateAuthority, ["materialize"])
    ) ||
    typeof input.sourceCaptureAuthority.capture !== "function" ||
    typeof input.templateAuthority.materialize !== "function" ||
    !denseDataArray(input.templates) ||
    input.templates.length === 0 ||
    input.templates.length > 128
  ) {
    return;
  }
  const templates = new Map<string, TemplateRegistration>();
  for (const raw of input.templates) {
    if (!plainRecord(raw, ["id", "language"])) return;
    const id = raw.id;
    if (
      typeof id !== "string" ||
      !IDENTIFIER_PATTERN.test(id) ||
      typeof raw.language !== "string" ||
      !IDENTIFIER_PATTERN.test(raw.language) ||
      templates.has(id)
    ) {
      return;
    }
    templates.set(id, { id, language: raw.language });
  }
  return {
    sourceCapture: input.sourceCaptureAuthority.capture.bind(
      input.sourceCaptureAuthority,
    ),
    materializeTemplate: input.templateAuthority.materialize.bind(
      input.templateAuthority,
    ),
    templates,
  };
}
