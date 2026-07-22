import type { CapturedRecord, ParsedConfig } from "./authority-state.ts";
import type {
  SourceCaptureReceipt,
  SourceCaptureResult,
  SourceEvidenceAuthority,
} from "./contract.ts";
import { parseCaptured, parseSourceBindings, sameBindings } from "./parse.ts";
import { digestValue, rejected } from "./primitives.ts";

export function createCapture(
  config: ParsedConfig,
  captures: WeakMap<object, CapturedRecord>,
): SourceEvidenceAuthority["capture"] {
  return async (value: unknown): Promise<SourceCaptureResult> => {
    const bindings = parseSourceBindings(
      value,
      new Set([...config.templates.values()].map(({ language }) => language)),
    );
    if (bindings === "unsupported") {
      return rejected("UNSUPPORTED_LANGUAGE");
    }
    if (bindings === undefined) return rejected("INVALID_INPUT");
    let raw: unknown;
    try {
      raw = await config.sourceCapture(Object.freeze({ ...bindings }));
    } catch {
      return rejected("SOURCE_CAPTURE_REJECTED");
    }
    const captured = parseCaptured(raw, bindings);
    if (captured === undefined) return rejected("SOURCE_CAPTURE_REJECTED");
    if (!sameBindings(captured, bindings)) {
      return rejected("SOURCE_CAPTURE_STALE");
    }
    const material = Object.freeze({
      ...bindings,
      baselineDigest: captured.baselineDigest,
    });
    const receipt: SourceCaptureReceipt = Object.freeze({
      ...material,
      receiptDigest: digestValue(material),
    });
    captures.set(receipt, {
      receipt,
      baselineBytes: captured.baselineBytes,
    });
    return Object.freeze({ status: "captured", receipt });
  };
}
