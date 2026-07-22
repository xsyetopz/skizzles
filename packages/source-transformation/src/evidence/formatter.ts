import { type Digest, digestText } from "../digest.ts";
import { semanticDigest } from "../typescript/editor.ts";
import { parseTypeScriptSource } from "../typescript/parser.ts";
import type {
  FormatterPass,
  FormatterPassRequest,
  FormatterPassResult,
  FormatterProfileRegistration,
  FormatterProfileRegistrationResult,
  FormatterProvenanceReceipt,
  RegisteredFormatterProfile,
  TypeScriptFormatterInput,
  TypeScriptFormatterResult,
} from "./contract.ts";

type FormatAuthority = (
  request: Readonly<FormatterPassRequest>,
) => unknown | Promise<unknown>;

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const profiles = new WeakMap<RegisteredFormatterProfile, FormatAuthority>();
const encoder = new TextEncoder();

export function registerTypeScriptFormatterProfile(
  input: unknown,
): FormatterProfileRegistrationResult {
  try {
    const registration = parseRegistration(input);
    if (registration === undefined) {
      return rejectedProfile();
    }
    const profile = Object.freeze({
      profileId: registration.profileId,
      language: registration.language,
      tool: registration.tool,
      version: registration.version,
      configDigest: registration.configDigest,
    });
    profiles.set(
      profile,
      registration.authority.format.bind(registration.authority),
    );
    return Object.freeze({ status: "registered", profile });
  } catch {
    return rejectedProfile();
  }
}

export function formatTypeScriptCandidate(
  input: TypeScriptFormatterInput,
): Promise<TypeScriptFormatterResult> {
  return formatCandidate(input).catch(() => rejected("FORMATTER_REJECTED"));
}

async function formatCandidate(
  input: TypeScriptFormatterInput,
): Promise<TypeScriptFormatterResult> {
  if (!validInput(input)) {
    return rejected("INVALID_FORMATTER_INPUT");
  }
  const authority = profiles.get(input.profile);
  if (authority === undefined) {
    return rejected("UNREGISTERED_FORMATTER_PROFILE");
  }

  const candidateDigest = digestText(input.candidate.text);
  const candidateSemanticDigest = semanticDigest(input.candidate.sourceFile);
  const pass1 = await invokeFormatter(
    authority,
    input,
    1,
    input.candidate.text,
    candidateDigest,
  );
  if (pass1.status === "rejected") {
    return pass1;
  }
  const parsedPass1 = await parseTypeScriptSource({
    targetPath: input.candidate.path,
    sourceText: pass1.result.formattedText,
  });
  if (parsedPass1.status !== "parsed") {
    return rejected("FORMATTER_SYNTAX_REJECTED");
  }
  if (
    semanticDigest(parsedPass1.parsed.sourceFile) !== candidateSemanticDigest
  ) {
    return rejected("FORMATTER_SEMANTIC_DRIFT");
  }

  const pass1Digest = digestText(pass1.result.formattedText);
  const pass2 = await invokeFormatter(
    authority,
    input,
    2,
    pass1.result.formattedText,
    pass1Digest,
  );
  if (pass2.status === "rejected") {
    return pass2;
  }
  const parsedPass2 = await parseTypeScriptSource({
    targetPath: input.candidate.path,
    sourceText: pass2.result.formattedText,
  });
  if (parsedPass2.status !== "parsed") {
    return rejected("FORMATTER_SYNTAX_REJECTED");
  }
  const formattedSemanticDigest = semanticDigest(parsedPass2.parsed.sourceFile);
  if (formattedSemanticDigest !== candidateSemanticDigest) {
    return rejected("FORMATTER_SEMANTIC_DRIFT");
  }
  const pass2Digest = digestText(pass2.result.formattedText);
  if (
    pass1.result.formattedText !== pass2.result.formattedText ||
    pass1Digest !== pass2Digest
  ) {
    return rejected("FORMATTER_NOT_IDEMPOTENT");
  }

  const receipt = createReceipt({
    input,
    candidateDigest,
    candidateSemanticDigest,
    pass1Digest,
    pass2Digest,
    formattedSemanticDigest,
    formattedText: pass2.result.formattedText,
  });
  return Object.freeze({ status: "formatted", receipt });
}

async function invokeFormatter(
  authority: FormatAuthority,
  input: TypeScriptFormatterInput,
  pass: FormatterPass,
  sourceText: string,
  inputDigest: Digest,
): Promise<
  | Readonly<{ status: "accepted"; result: FormatterPassResult }>
  | Extract<TypeScriptFormatterResult, { status: "rejected" }>
> {
  const request: Readonly<FormatterPassRequest> = Object.freeze({
    pass,
    profileId: input.profile.profileId,
    path: input.candidate.path,
    treeDigest: input.treeDigest,
    configDigest: input.profile.configDigest,
    tool: input.profile.tool,
    version: input.profile.version,
    candidateDigest: digestText(input.candidate.text),
    inputDigest,
    sourceText,
  });
  let raw: unknown;
  try {
    raw = await authority(request);
  } catch {
    return rejected("FORMATTER_REJECTED");
  }
  const result = parsePassResult(raw);
  if (result === undefined) {
    return rejected("FORMATTER_RESULT_INVALID");
  }
  if (!matchesRequest(result, request)) {
    return rejected("FORMATTER_BINDING_MISMATCH");
  }
  return Object.freeze({ status: "accepted", result });
}

function createReceipt(input: {
  readonly input: TypeScriptFormatterInput;
  readonly candidateDigest: Digest;
  readonly candidateSemanticDigest: Digest;
  readonly pass1Digest: Digest;
  readonly pass2Digest: Digest;
  readonly formattedSemanticDigest: Digest;
  readonly formattedText: string;
}): FormatterProvenanceReceipt {
  const formattedDigest = digestText(input.formattedText);
  const provenanceDigest = digestText(
    JSON.stringify([
      input.input.candidate.path,
      input.input.profile.profileId,
      input.input.profile.tool,
      input.input.profile.version,
      input.input.treeDigest,
      input.input.profile.configDigest,
      input.candidateDigest,
      input.candidateSemanticDigest,
      input.pass1Digest,
      input.pass2Digest,
      formattedDigest,
      input.formattedSemanticDigest,
    ]),
  );
  return Object.freeze({
    path: input.input.candidate.path,
    profileId: input.input.profile.profileId,
    tool: input.input.profile.tool,
    version: input.input.profile.version,
    treeDigest: input.input.treeDigest,
    configDigest: input.input.profile.configDigest,
    candidateDigest: input.candidateDigest,
    candidateSemanticDigest: input.candidateSemanticDigest,
    pass1Digest: input.pass1Digest,
    pass2Digest: input.pass2Digest,
    formattedDigest,
    formattedSemanticDigest: input.formattedSemanticDigest,
    provenanceDigest,
    formattedBytes: Object.freeze([...encoder.encode(input.formattedText)]),
  });
}

function parseRegistration(
  value: unknown,
): FormatterProfileRegistration | undefined {
  const record = exactRecord(value, [
    "profileId",
    "language",
    "tool",
    "version",
    "configDigest",
    "authority",
  ]);
  if (record === undefined) {
    return;
  }
  const authority = exactRecord(record.get("authority"), ["format"]);
  const profileId = record.get("profileId");
  const language = record.get("language");
  const tool = record.get("tool");
  const version = record.get("version");
  const configDigest = record.get("configDigest");
  const format = authority?.get("format");
  if (
    !validIdentity(profileId) ||
    !validIdentity(language) ||
    !validIdentity(tool) ||
    !validIdentity(version) ||
    !validDigest(configDigest) ||
    !isFormatAuthority(format)
  ) {
    return;
  }
  return {
    profileId,
    language,
    tool,
    version,
    configDigest,
    authority: { format },
  };
}

function isFormatAuthority(value: unknown): value is FormatAuthority {
  return typeof value === "function";
}

function parsePassResult(value: unknown): FormatterPassResult | undefined {
  if (!Object.isFrozen(value)) {
    return;
  }
  const record = exactRecord(value, [
    "pass",
    "profileId",
    "path",
    "treeDigest",
    "configDigest",
    "tool",
    "version",
    "candidateDigest",
    "inputDigest",
    "formattedText",
  ]);
  if (record === undefined) {
    return;
  }
  const pass = record.get("pass");
  const profileId = record.get("profileId");
  const path = record.get("path");
  const treeDigest = record.get("treeDigest");
  const configDigest = record.get("configDigest");
  const tool = record.get("tool");
  const version = record.get("version");
  const candidateDigest = record.get("candidateDigest");
  const inputDigest = record.get("inputDigest");
  const formattedText = record.get("formattedText");
  if (
    (pass !== 1 && pass !== 2) ||
    !validIdentity(profileId) ||
    typeof path !== "string" ||
    !validDigest(treeDigest) ||
    !validDigest(configDigest) ||
    !validIdentity(tool) ||
    !validIdentity(version) ||
    !validDigest(candidateDigest) ||
    !validDigest(inputDigest) ||
    typeof formattedText !== "string"
  ) {
    return;
  }
  return Object.freeze({
    pass,
    profileId,
    path,
    treeDigest,
    configDigest,
    tool,
    version,
    candidateDigest,
    inputDigest,
    formattedText,
  });
}

function matchesRequest(
  result: FormatterPassResult,
  request: FormatterPassRequest,
): boolean {
  return (
    result.pass === request.pass &&
    result.profileId === request.profileId &&
    result.path === request.path &&
    result.treeDigest === request.treeDigest &&
    result.configDigest === request.configDigest &&
    result.tool === request.tool &&
    result.version === request.version &&
    result.candidateDigest === request.candidateDigest &&
    result.inputDigest === request.inputDigest
  );
}

function validInput(value: TypeScriptFormatterInput): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    validDigest(value.treeDigest) &&
    typeof value.candidate === "object" &&
    value.candidate !== null &&
    typeof value.candidate.path === "string" &&
    value.candidate.path.length > 0 &&
    typeof value.candidate.text === "string" &&
    typeof value.candidate.sourceFile === "object" &&
    value.candidate.sourceFile !== null &&
    value.candidate.sourceFile.text === value.candidate.text &&
    typeof value.candidate.sourceFile.forEachChild === "function" &&
    typeof value.profile === "object" &&
    value.profile !== null
  );
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return;
  }
  const result = new Map<string, unknown>();
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return;
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes("\0")
  );
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}

function rejected(
  code: Extract<TypeScriptFormatterResult, { status: "rejected" }>["code"],
): Extract<TypeScriptFormatterResult, { status: "rejected" }> {
  return Object.freeze({ status: "rejected", code });
}

function rejectedProfile(): Extract<
  FormatterProfileRegistrationResult,
  { status: "rejected" }
> {
  return Object.freeze({
    status: "rejected",
    code: "INVALID_FORMATTER_PROFILE",
  });
}
