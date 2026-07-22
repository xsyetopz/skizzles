import type { SourceBindings } from "./authority-state.ts";
import type { SourceEvidenceLanguage } from "./contract.ts";
import {
  asString,
  boundedString,
  digestBytes,
  digestString,
  frozenBytes,
  IDENTIFIER_PATTERN,
  MAXIMUM_BASELINE_BYTES,
  MAXIMUM_NODE_SOURCE_BYTES,
  plainDataRecord,
  plainRecordShape,
  sourcePath,
} from "./primitives.ts";

export function parseSourceBindings(
  input: unknown,
  supportedLanguages?: ReadonlySet<string>,
): SourceBindings | "unsupported" | undefined {
  if (
    !plainDataRecord(input, [
      "requestDigest",
      "repositoryId",
      "rootIdentity",
      "treeDigest",
      "configDigest",
      "path",
      "language",
    ])
  ) {
    return;
  }
  if (
    typeof input.language !== "string" ||
    !IDENTIFIER_PATTERN.test(input.language)
  ) {
    return;
  }
  if (
    supportedLanguages !== undefined &&
    !supportedLanguages.has(input.language)
  ) {
    return "unsupported";
  }
  if (
    !(
      digestString(input.requestDigest) &&
      boundedString(input.repositoryId, 512) &&
      boundedString(input.rootIdentity, 512) &&
      digestString(input.treeDigest) &&
      digestString(input.configDigest) &&
      sourcePath(input.path)
    )
  ) {
    return;
  }
  return Object.freeze({
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    rootIdentity: input.rootIdentity,
    treeDigest: input.treeDigest,
    configDigest: input.configDigest,
    path: input.path,
    language: input.language,
  });
}

export function parseCaptured(
  input: unknown,
  _expected: SourceBindings,
):
  | (SourceBindings & {
      readonly baselineDigest: string;
      readonly baselineBytes: readonly number[];
    })
  | undefined {
  if (
    !(
      plainDataRecord(input, [
        "requestDigest",
        "repositoryId",
        "rootIdentity",
        "treeDigest",
        "configDigest",
        "path",
        "language",
        "baselineDigest",
        "baselineBytes",
      ]) &&
      Object.isFrozen(input) &&
      digestString(input.baselineDigest)
    )
  ) {
    return;
  }
  const bindings = parseSourceBindings(
    {
      requestDigest: input.requestDigest,
      repositoryId: input.repositoryId,
      rootIdentity: input.rootIdentity,
      treeDigest: input.treeDigest,
      configDigest: input.configDigest,
      path: input.path,
      language: input.language,
    },
    new Set([_expected.language]),
  );
  const baselineBytes = frozenBytes(
    input.baselineBytes,
    MAXIMUM_BASELINE_BYTES,
  );
  if (
    typeof bindings !== "object" ||
    bindings === null ||
    baselineBytes === undefined ||
    digestBytes(baselineBytes) !== input.baselineDigest
  ) {
    return;
  }
  return { ...bindings, baselineDigest: input.baselineDigest, baselineBytes };
}

export function parseTemplateRequest(input: unknown):
  | {
      readonly capture: object;
      readonly templateId: string;
      readonly nodeSource: string;
    }
  | undefined {
  if (
    !(
      plainDataRecord(input, ["capture", "templateId", "nodeSource"]) &&
      plainRecordShape(input.capture) &&
      typeof input.templateId === "string" &&
      IDENTIFIER_PATTERN.test(input.templateId) &&
      boundedString(input.nodeSource, MAXIMUM_NODE_SOURCE_BYTES)
    )
  ) {
    return;
  }
  return {
    capture: input.capture,
    templateId: input.templateId,
    nodeSource: input.nodeSource,
  };
}

export function parseTemplateProvenance(input: unknown):
  | {
      readonly requestDigest: string;
      readonly repositoryId: string;
      readonly rootIdentity: string;
      readonly treeDigest: string;
      readonly configDigest: string;
      readonly path: string;
      readonly language: SourceEvidenceLanguage;
      readonly baselineDigest: string;
      readonly templateId: string;
      readonly templateDigest: string;
      readonly tool: string;
      readonly toolVersion: string;
      readonly contentDigest: string;
      readonly schemaDigest: string;
      readonly nodeSourceDigest: string;
    }
  | undefined {
  const keys = [
    "requestDigest",
    "repositoryId",
    "rootIdentity",
    "treeDigest",
    "configDigest",
    "path",
    "language",
    "baselineDigest",
    "templateId",
    "templateDigest",
    "tool",
    "toolVersion",
    "contentDigest",
    "schemaDigest",
    "nodeSourceDigest",
  ] as const;
  if (!(plainDataRecord(input, keys) && Object.isFrozen(input))) return;
  for (const key of [
    "requestDigest",
    "treeDigest",
    "configDigest",
    "baselineDigest",
    "templateDigest",
    "contentDigest",
    "schemaDigest",
    "nodeSourceDigest",
  ] as const) {
    if (!digestString(input[key])) return;
  }
  if (
    !(
      boundedString(input.repositoryId, 512) &&
      boundedString(input.rootIdentity, 512) &&
      sourcePath(input.path)
    ) ||
    typeof input.language !== "string" ||
    !IDENTIFIER_PATTERN.test(input.language) ||
    !IDENTIFIER_PATTERN.test(asString(input.templateId)) ||
    !boundedString(input.tool, 128) ||
    !boundedString(input.toolVersion, 128)
  ) {
    return;
  }
  const requestDigest = input.requestDigest;
  const repositoryId = input.repositoryId;
  const rootIdentity = input.rootIdentity;
  const treeDigest = input.treeDigest;
  const configDigest = input.configDigest;
  const path = input.path;
  const baselineDigest = input.baselineDigest;
  const templateId = input.templateId;
  const templateDigest = input.templateDigest;
  const tool = input.tool;
  const toolVersion = input.toolVersion;
  const contentDigest = input.contentDigest;
  const schemaDigest = input.schemaDigest;
  const nodeSourceDigest = input.nodeSourceDigest;
  if (
    typeof requestDigest !== "string" ||
    typeof repositoryId !== "string" ||
    typeof rootIdentity !== "string" ||
    typeof treeDigest !== "string" ||
    typeof configDigest !== "string" ||
    typeof path !== "string" ||
    typeof baselineDigest !== "string" ||
    typeof templateId !== "string" ||
    typeof templateDigest !== "string" ||
    typeof tool !== "string" ||
    typeof toolVersion !== "string" ||
    typeof contentDigest !== "string" ||
    typeof schemaDigest !== "string" ||
    typeof nodeSourceDigest !== "string"
  ) {
    return;
  }
  return {
    requestDigest,
    repositoryId,
    rootIdentity,
    treeDigest,
    configDigest,
    path,
    language: input.language,
    baselineDigest,
    templateId,
    templateDigest,
    tool,
    toolVersion,
    contentDigest,
    schemaDigest,
    nodeSourceDigest,
  };
}

export function sameBindings(
  actual: SourceBindings,
  expected: SourceBindings,
): boolean {
  return (
    actual.requestDigest === expected.requestDigest &&
    actual.repositoryId === expected.repositoryId &&
    actual.rootIdentity === expected.rootIdentity &&
    actual.treeDigest === expected.treeDigest &&
    actual.configDigest === expected.configDigest &&
    actual.path === expected.path &&
    actual.language === expected.language
  );
}

export function sameTemplateBinding(
  actual: NonNullable<ReturnType<typeof parseTemplateProvenance>>,
  expected: SourceBindings & {
    readonly baselineDigest: string;
    readonly templateId: string;
    readonly nodeSourceDigest: string;
  },
): boolean {
  return (
    sameBindings(actual, expected) &&
    actual.baselineDigest === expected.baselineDigest &&
    actual.templateId === expected.templateId &&
    actual.nodeSourceDigest === expected.nodeSourceDigest
  );
}
