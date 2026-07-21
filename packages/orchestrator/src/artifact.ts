import {
  bytesOf,
  exactKeys,
  isRecord,
  nonempty,
  stringArray,
} from "./codec.ts";
import {
  type Diagnostic,
  type DiagnosticInterceptor,
  interceptDiagnostic,
} from "./diagnostic.ts";
import { type Digest, digestBytes } from "./digest.ts";

export type ArtifactKind = "code" | "configuration" | "patch" | "schema";

export interface ArtifactValidator {
  readonly kind: ArtifactKind;
  validate: (bytes: Uint8Array) => unknown | Promise<unknown>;
}

export interface CompleteArtifact {
  readonly kind: ArtifactKind;
  readonly bytes: readonly number[];
  readonly digest: Digest;
}

export interface PresentationBlock {
  readonly text: string;
  readonly estimatedTokens: number;
  readonly byteLength: number;
}

export interface OutputBoundary {
  readonly artifacts: readonly CompleteArtifact[];
  readonly presentation: readonly PresentationBlock[];
  readonly omittedPresentation: number;
  readonly diagnostics: readonly Diagnostic[];
}

export type OutputResult =
  | { readonly status: "accepted"; readonly output: OutputBoundary }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_OUTPUT"
        | "UNKNOWN_ARTIFACT_KIND"
        | "INCOMPLETE_ARTIFACT"
        | "INVALID_DIAGNOSTIC";
    };

export type FilePayloadResult =
  | {
      readonly status: "accepted";
      readonly kind: ArtifactKind;
      readonly bytes: readonly number[];
      readonly digest: Digest;
    }
  | { readonly status: "rejected"; readonly code: "UNVERIFIED_ARTIFACT" };

const artifactKinds = new Set<string>([
  "code",
  "configuration",
  "patch",
  "schema",
]);
function isArtifactKind(value: unknown): value is ArtifactKind {
  return (
    value === "code" ||
    value === "configuration" ||
    value === "patch" ||
    value === "schema"
  );
}

export class ArtifactRegistry {
  private readonly artifacts = new WeakMap<object, CompleteArtifact>();
  private readonly validators: ReadonlyMap<ArtifactKind, ArtifactValidator>;
  private readonly tokenCap: number;
  private readonly byteCap: number;
  private readonly interceptor: DiagnosticInterceptor | undefined;

  constructor(
    validators: readonly ArtifactValidator[],
    tokenCap: number,
    byteCap: number,
    interceptor?: DiagnosticInterceptor,
  ) {
    this.validators = new Map(
      validators.map((validator) => [validator.kind, validator]),
    );
    this.tokenCap = tokenCap;
    this.byteCap = byteCap;
    this.interceptor = interceptor;
  }

  static parseValidators(
    value: unknown,
    tokenCap: unknown,
    byteCap: unknown,
  ): readonly ArtifactValidator[] | undefined {
    if (
      !Array.isArray(value) ||
      typeof tokenCap !== "number" ||
      !Number.isSafeInteger(tokenCap) ||
      tokenCap < 0 ||
      typeof byteCap !== "number" ||
      !Number.isSafeInteger(byteCap) ||
      byteCap < 0
    ) {
      return undefined;
    }
    const seen = new Set<string>();
    const validators: ArtifactValidator[] = [];
    for (const validator of value) {
      if (
        !(isRecord(validator) && exactKeys(validator, ["kind", "validate"])) ||
        !isArtifactKind(validator.kind) ||
        typeof validator.validate !== "function" ||
        seen.has(validator.kind)
      ) {
        return undefined;
      }
      seen.add(validator.kind);
      const validate = validator.validate;
      validators.push(
        Object.freeze({
          kind: validator.kind,
          validate: (bytes: Uint8Array) =>
            Reflect.apply(validate, validator, [bytes]),
        }),
      );
    }
    return Object.freeze(validators);
  }

  async validate(input: unknown): Promise<OutputResult | CompleteArtifact> {
    if (isRecord(input)) {
      const verified = this.artifacts.get(input);
      if (verified !== undefined) return verified;
    }
    if (
      !(isRecord(input) && exactKeys(input, ["kind", "bytes"])) ||
      !isArtifactKind(input.kind)
    ) {
      return {
        status: "rejected",
        code:
          isRecord(input) &&
          typeof input.kind === "string" &&
          !artifactKinds.has(input.kind)
            ? "UNKNOWN_ARTIFACT_KIND"
            : "INVALID_OUTPUT",
      };
    }
    const kind = input.kind;
    const validator = this.validators.get(kind);
    if (validator === undefined) {
      return { status: "rejected", code: "UNKNOWN_ARTIFACT_KIND" };
    }
    const bytes = bytesOf(input.bytes);
    if (bytes === undefined || bytes.length === 0) {
      return { status: "rejected", code: "INCOMPLETE_ARTIFACT" };
    }
    let validation: unknown;
    try {
      validation = await validator.validate(Uint8Array.from(bytes));
    } catch {
      return { status: "rejected", code: "INCOMPLETE_ARTIFACT" };
    }
    if (!(isRecord(validation) && exactKeys(validation, ["valid"], ["code"]))) {
      return { status: "rejected", code: "INCOMPLETE_ARTIFACT" };
    }
    if (
      validation.valid !== true ||
      (Object.hasOwn(validation, "code") && !nonempty(validation.code))
    ) {
      return { status: "rejected", code: "INCOMPLETE_ARTIFACT" };
    }
    const artifact: CompleteArtifact = Object.freeze({
      kind,
      bytes,
      digest: digestBytes(Uint8Array.from(bytes)),
    });
    this.artifacts.set(artifact, artifact);
    return artifact;
  }

  async compose(input: unknown): Promise<OutputResult> {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["artifacts", "presentation", "diagnostics"]) &&
        Array.isArray(input.artifacts) &&
        Array.isArray(input.diagnostics)
      ) ||
      stringArray(input.presentation) === undefined
    ) {
      return { status: "rejected", code: "INVALID_OUTPUT" };
    }
    const acceptedArtifacts: CompleteArtifact[] = [];
    for (const item of input.artifacts) {
      const artifact = await this.validate(item);
      if ("status" in artifact) {
        return artifact;
      }
      acceptedArtifacts.push(artifact);
    }
    const acceptedDiagnostics: Diagnostic[] = [];
    for (const item of input.diagnostics) {
      const diagnostic = await interceptDiagnostic(item, this.interceptor);
      if (diagnostic.status === "rejected") {
        return { status: "rejected", code: "INVALID_DIAGNOSTIC" };
      }
      acceptedDiagnostics.push(diagnostic.diagnostic);
    }

    let usedTokens = 0;
    let usedBytes = 0;
    let omittedPresentation = 0;
    const presentation: PresentationBlock[] = [];
    const textBlocks = stringArray(input.presentation) ?? [];
    for (const text of textBlocks) {
      const byteLength = new TextEncoder().encode(text).byteLength;
      const estimatedTokens = estimateTokens(text, byteLength);
      if (
        usedTokens + estimatedTokens > this.tokenCap ||
        usedBytes + byteLength > this.byteCap
      ) {
        omittedPresentation += 1;
        continue;
      }
      presentation.push(Object.freeze({ text, estimatedTokens, byteLength }));
      usedTokens += estimatedTokens;
      usedBytes += byteLength;
    }
    return {
      status: "accepted",
      output: Object.freeze({
        artifacts: Object.freeze(acceptedArtifacts),
        presentation: Object.freeze(presentation),
        omittedPresentation,
        diagnostics: Object.freeze(acceptedDiagnostics),
      }),
    };
  }

  filePayload(input: unknown): FilePayloadResult {
    if (!isRecord(input)) {
      return { status: "rejected", code: "UNVERIFIED_ARTIFACT" };
    }
    const artifact = this.artifacts.get(input);
    if (artifact === undefined) {
      return { status: "rejected", code: "UNVERIFIED_ARTIFACT" };
    }
    if (digestBytes(Uint8Array.from(artifact.bytes)) !== artifact.digest) {
      return { status: "rejected", code: "UNVERIFIED_ARTIFACT" };
    }
    return {
      status: "accepted",
      kind: artifact.kind,
      bytes: Object.freeze([...artifact.bytes]),
      digest: artifact.digest,
    };
  }
}

function estimateTokens(text: string, byteLength: number): number {
  if (text.length === 0) {
    return 0;
  }
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length;
  return Math.max(1, words, Math.ceil(byteLength / 4));
}
