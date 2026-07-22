import { posix } from "node:path";
import {
  isChangeAssurance,
  isChangeDeclaration,
} from "@skizzles/change-assurance";
import { isSourceEngineering } from "@skizzles/source-engineering";
import { nonempty } from "../codec.ts";
import { digestValue } from "../digest.ts";
import { isNormalizedRequest } from "../intent.ts";
import { isRepositoryContext } from "../repository.ts";
import type { ContextBudgetAuthorityPort } from "./context.ts";
import type {
  EngineeringDeclarationKind,
  EngineeringEditOperation,
  EngineeringFaultDeclaration,
  EngineeringNegativeEvidence,
  EngineeringNodeSelector,
  EngineeringPrepareInput,
  EngineeringTarget,
  EngineeringValidationProfile,
  EngineeringWorkflowConfig,
} from "./contract.ts";
import type { PhysicalIntegrationAuthorityPort } from "./physical.ts";
import {
  hasOwnDataMethods,
  isFrozenOpaque,
  snapshotArray,
  snapshotRecord,
} from "./snapshot.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumTargets = 64;
const maximumOperations = 256;
const maximumFaults = 256;
const maximumNodeSourceBytes = 262_144;

export type ParsedEngineeringInput = Omit<
  EngineeringPrepareInput,
  "context"
> & {
  readonly context: unknown;
  readonly profile: EngineeringValidationProfile;
};

export function parseEngineeringConfig(
  input: unknown,
): EngineeringWorkflowConfig | undefined {
  const value = snapshotRecord(input, [
    "causal",
    "sourceEngineering",
    "changeAssurance",
    "contextBudget",
    "physicalIntegration",
    "validationProfiles",
    "discoveryRoot",
  ]);
  if (
    !(
      value !== undefined &&
      hasCausalConfig(value["causal"]) &&
      isSourceEngineering(value["sourceEngineering"]) &&
      isChangeAssurance(value["changeAssurance"]) &&
      isContextBudget(value["contextBudget"]) &&
      isPhysicalIntegration(value["physicalIntegration"]) &&
      nonempty(value["discoveryRoot"], 1024)
    )
  ) {
    return;
  }
  const profiles = parseProfiles(value["validationProfiles"], value["causal"]);
  if (profiles === undefined) return;
  return Object.freeze({
    causal: value["causal"],
    sourceEngineering: value["sourceEngineering"],
    changeAssurance: value["changeAssurance"],
    contextBudget: value["contextBudget"],
    physicalIntegration: value["physicalIntegration"],
    validationProfiles: profiles,
    discoveryRoot: value["discoveryRoot"],
  });
}

export function parseEngineeringInput(
  input: unknown,
  profiles: readonly EngineeringValidationProfile[],
): ParsedEngineeringInput | undefined {
  const value = snapshotRecord(input, [
    "request",
    "repository",
    "context",
    "changeDeclaration",
    "targets",
    "faultDeclarations",
    "validationProfile",
    "integrations",
  ]);
  if (
    !(
      value !== undefined &&
      isNormalizedRequest(value["request"]) &&
      isRepositoryContext(value["repository"]) &&
      isChangeDeclaration(value["changeDeclaration"]) &&
      value["request"].intentDigest === value["repository"].requestDigest &&
      typeof value["validationProfile"] === "string"
    )
  ) {
    return;
  }
  const targets = parseTargets(value["targets"]);
  const faultDeclarations = parseFaults(value["faultDeclarations"]);
  const profile = profiles.find(
    (candidate) => candidate.id === value["validationProfile"],
  );
  const integrations = parseIntegrations(value["integrations"]);
  if (
    targets === undefined ||
    faultDeclarations === undefined ||
    profile === undefined ||
    (faultDeclarations.negativeTests.length > 0 &&
      profile.negativeTestCommands.length === 0) ||
    integrations === undefined ||
    value["changeDeclaration"].requestDigest !==
      value["request"].intentDigest ||
    value["changeDeclaration"].repositoryId !==
      value["repository"].repositoryId ||
    value["changeDeclaration"].targetSetDigest !==
      digestValue(
        targets.map(({ path }) => Object.freeze({ path, operation: "write" })),
      )
  ) {
    return;
  }
  return Object.freeze({
    request: value["request"],
    repository: value["repository"],
    context: value["context"],
    changeDeclaration: value["changeDeclaration"],
    targets,
    faultDeclarations,
    validationProfile: profile.id,
    integrations,
    profile,
  });
}

function parseProfiles(
  input: unknown,
  causal: unknown,
): readonly EngineeringValidationProfile[] | undefined {
  const values = snapshotArray(input, maximumTargets);
  const causalValue = snapshotRecord(causal, [
    "orchestrator",
    "publicationIdentity",
    "baselineAuthority",
    "transaction",
    "workspaceUsageLimits",
    "commandProfiles",
    "approvalContext",
  ]);
  const causalProfiles = snapshotArray(
    causalValue?.["commandProfiles"],
    maximumTargets,
  );
  if (
    !(
      values !== undefined &&
      values.length > 0 &&
      causalValue !== undefined &&
      causalProfiles !== undefined
    )
  ) {
    return;
  }
  const available = new Set<string>();
  for (const profile of causalProfiles) {
    const candidate = snapshotRecord(
      profile,
      [
        "id",
        "argv",
        "env",
        "timeoutMilliseconds",
        "maximumOutputBytes",
        "drainMilliseconds",
        "signalGraceMilliseconds",
        "allowedExitCodes",
        "stderr",
      ],
      ["cwd", "dependencyPackages"],
    );
    if (candidate === undefined || typeof candidate["id"] !== "string") return;
    available.add(candidate["id"]);
  }
  const profiles: EngineeringValidationProfile[] = [];
  const ids = new Set<string>();
  for (const raw of values) {
    const value = snapshotRecord(raw, [
      "id",
      "language",
      "objective",
      "formatterId",
      "commandProfileIds",
      "negativeTestCommands",
    ]);
    if (
      !(
        value !== undefined &&
        nonempty(value["id"], 128) &&
        nonempty(value["language"], 128) &&
        !ids.has(value["id"]) &&
        (value["objective"] === "behavioral" ||
          value["objective"] === "format-only") &&
        nonempty(value["formatterId"], 128) &&
        snapshotArray(value["commandProfileIds"], maximumTargets) !==
          undefined &&
        snapshotArray(value["negativeTestCommands"], maximumTargets) !==
          undefined
      )
    ) {
      return;
    }
    const commandProfileValues = snapshotArray(
      value["commandProfileIds"],
      maximumTargets,
    );
    if (commandProfileValues === undefined || commandProfileValues.length === 0)
      return;
    const commandProfileIds: string[] = [];
    for (const id of commandProfileValues) {
      if (
        typeof id !== "string" ||
        !available.has(id) ||
        commandProfileIds.includes(id)
      ) {
        return;
      }
      commandProfileIds.push(id);
    }
    const negativeCommandValues = snapshotArray(
      value["negativeTestCommands"],
      maximumTargets,
    );
    if (negativeCommandValues === undefined) return;
    const negativeTestCommands: EngineeringValidationProfile["negativeTestCommands"][number][] =
      [];
    const negativeProfileIds = new Set<string>();
    const negativeTestPaths = new Set<string>();
    for (const rawCommand of negativeCommandValues) {
      const command = snapshotRecord(rawCommand, ["profileId", "testPaths"]);
      const profileId = command?.["profileId"];
      const pathValues = snapshotArray(command?.["testPaths"], maximumFaults);
      if (
        typeof profileId !== "string" ||
        !available.has(profileId) ||
        commandProfileIds.includes(profileId) ||
        negativeProfileIds.has(profileId) ||
        pathValues === undefined ||
        pathValues.length === 0
      ) {
        return;
      }
      const testPaths: string[] = [];
      for (const rawPath of pathValues) {
        const path = normalizePath(rawPath);
        if (path === undefined || negativeTestPaths.has(path)) return;
        negativeTestPaths.add(path);
        testPaths.push(path);
      }
      negativeProfileIds.add(profileId);
      negativeTestCommands.push(
        Object.freeze({
          profileId,
          testPaths: Object.freeze(
            testPaths.sort((left, right) => left.localeCompare(right)),
          ),
        }),
      );
    }
    ids.add(value["id"]);
    profiles.push(
      Object.freeze({
        id: value["id"],
        language: value["language"],
        objective: value["objective"],
        formatterId: value["formatterId"],
        commandProfileIds: Object.freeze(commandProfileIds),
        negativeTestCommands: Object.freeze(negativeTestCommands),
      }),
    );
  }
  return Object.freeze(profiles);
}

function parseTargets(
  input: unknown,
): readonly EngineeringTarget[] | undefined {
  const values = snapshotArray(input, maximumTargets);
  if (values === undefined || values.length === 0) return;
  const targets: EngineeringTarget[] = [];
  const paths = new Set<string>();
  for (const raw of values) {
    const value = snapshotRecord(raw, ["path", "operations"]);
    if (value === undefined) return;
    const path = normalizePath(value["path"]);
    const operations = parseOperations(value["operations"]);
    if (path === undefined || paths.has(path) || operations === undefined)
      return;
    paths.add(path);
    targets.push(Object.freeze({ path, operations }));
  }
  targets.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(targets);
}

function parseOperations(
  input: unknown,
): readonly EngineeringEditOperation[] | undefined {
  const values = snapshotArray(input, maximumOperations);
  if (values === undefined || values.length === 0) {
    return;
  }
  const operations: EngineeringEditOperation[] = [];
  for (const raw of values) {
    const header = snapshotRecord(
      raw,
      ["kind"],
      ["selector", "anchor", "position", "templateId", "nodeSource"],
    );
    if (header === undefined || typeof header["kind"] !== "string") return;
    const value = header;
    if (value["kind"] === "delete") {
      const exact = snapshotRecord(raw, ["kind", "selector"]);
      const selector =
        exact === undefined ? undefined : parseSelector(exact["selector"]);
      if (selector === undefined) return;
      operations.push(Object.freeze({ kind: "delete", selector }));
      continue;
    }
    if (value["kind"] === "replace") {
      const exact = snapshotRecord(raw, [
        "kind",
        "selector",
        "templateId",
        "nodeSource",
      ]);
      const selector =
        exact === undefined ? undefined : parseSelector(exact["selector"]);
      if (
        selector === undefined ||
        !nonempty(exact?.["templateId"], 256) ||
        !validNodeSource(exact?.["nodeSource"])
      )
        return;
      operations.push(
        Object.freeze({
          kind: "replace",
          selector,
          templateId: exact["templateId"],
          nodeSource: exact["nodeSource"],
        }),
      );
      continue;
    }
    const exact = snapshotRecord(raw, [
      "kind",
      "anchor",
      "position",
      "templateId",
      "nodeSource",
    ]);
    if (
      !(
        exact !== undefined &&
        exact["kind"] === "insert" &&
        (exact["position"] === "before" || exact["position"] === "after") &&
        nonempty(exact["templateId"], 256) &&
        validNodeSource(exact["nodeSource"])
      )
    ) {
      return;
    }
    const anchor = parseSelector(exact["anchor"]);
    if (anchor === undefined) return;
    operations.push(
      Object.freeze({
        kind: "insert",
        anchor,
        position: exact["position"],
        templateId: exact["templateId"],
        nodeSource: exact["nodeSource"],
      }),
    );
  }
  return Object.freeze(operations);
}

function parseSelector(input: unknown): EngineeringNodeSelector | undefined {
  const value = snapshotRecord(input, [
    "declarationKind",
    "name",
    "expectedNodeDigest",
  ]);
  if (
    !(
      value !== undefined &&
      validDeclarationKind(value["declarationKind"]) &&
      nonempty(value["name"], 512) &&
      typeof value["expectedNodeDigest"] === "string" &&
      digestPattern.test(value["expectedNodeDigest"])
    )
  ) {
    return;
  }
  return Object.freeze({
    declarationKind: value["declarationKind"],
    name: value["name"],
    expectedNodeDigest: value["expectedNodeDigest"],
  });
}

function parseFaults(input: unknown):
  | {
      readonly declarations: readonly EngineeringFaultDeclaration[];
      readonly negativeTests: readonly EngineeringNegativeEvidence[];
    }
  | undefined {
  const value = snapshotRecord(input, ["declarations", "negativeTests"]);
  const declarationValues = snapshotArray(
    value?.["declarations"],
    maximumFaults,
  );
  const negativeValues = snapshotArray(value?.["negativeTests"], maximumFaults);
  if (
    !(
      value !== undefined &&
      declarationValues !== undefined &&
      negativeValues !== undefined
    )
  ) {
    return;
  }
  const declarations: EngineeringFaultDeclaration[] = [];
  for (const raw of declarationValues) {
    const declaration = snapshotRecord(raw, ["productionPath", "failureCodes"]);
    if (declaration === undefined) return;
    const productionPath = normalizePath(declaration["productionPath"]);
    const failureCodes = parseFailureCodes(declaration["failureCodes"]);
    if (productionPath === undefined || failureCodes === undefined) return;
    declarations.push(Object.freeze({ productionPath, failureCodes }));
  }
  const negativeTests: EngineeringNegativeEvidence[] = [];
  for (const raw of negativeValues) {
    const evidence = snapshotRecord(raw, ["productionPath", "testPath"]);
    if (evidence === undefined) return;
    const productionPath = normalizePath(evidence["productionPath"]);
    const testPath = normalizePath(evidence["testPath"]);
    if (productionPath === undefined || testPath === undefined) {
      return;
    }
    negativeTests.push(Object.freeze({ productionPath, testPath }));
  }
  return Object.freeze({
    declarations: Object.freeze(declarations),
    negativeTests: Object.freeze(negativeTests),
  });
}

function parseFailureCodes(input: unknown): readonly string[] | undefined {
  const values = snapshotArray(input, maximumFaults);
  if (values === undefined || values.length === 0) return;
  const result: string[] = [];
  for (const code of values) {
    if (!nonempty(code, 256) || result.includes(code)) return;
    result.push(code);
  }
  return Object.freeze(result.sort((left, right) => left.localeCompare(right)));
}

function parseIntegrations(input: unknown): readonly object[] | undefined {
  const values = snapshotArray(input, maximumTargets);
  if (values === undefined) return;
  const result: object[] = [];
  for (const declaration of values) {
    if (!isFrozenOpaque(declaration)) return;
    result.push(declaration);
  }
  return Object.freeze(result);
}

function normalizePath(input: unknown): string | undefined {
  if (
    !nonempty(input, 1024) ||
    input.startsWith("/") ||
    input.includes("\\") ||
    input.includes("\0")
  ) {
    return;
  }
  const normalized = posix.normalize(input);
  if (
    normalized !== input ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return;
  }
  return normalized;
}

function validDeclarationKind(
  value: unknown,
): value is EngineeringDeclarationKind {
  return (
    value === "class" ||
    value === "enum" ||
    value === "function" ||
    value === "interface" ||
    value === "type"
  );
}

function validNodeSource(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maximumNodeSourceBytes
  );
}

function hasCausalConfig(
  value: unknown,
): value is EngineeringWorkflowConfig["causal"] {
  const config = snapshotRecord(value, [
    "orchestrator",
    "publicationIdentity",
    "baselineAuthority",
    "transaction",
    "workspaceUsageLimits",
    "commandProfiles",
    "approvalContext",
  ]);
  return (
    config !== undefined &&
    hasOwnDataMethods(config["orchestrator"], [
      "captureTargetBaseline",
      "releaseTargetBaseline",
      "revalidateTargetBaseline",
    ]) &&
    snapshotRecord(config["publicationIdentity"], [
      "repositoryId",
      "rootIdentity",
      "ownerId",
    ]) !== undefined &&
    hasMethods(config["baselineAuthority"], ["capture"]) &&
    snapshotRecord(
      config["transaction"],
      ["destination", "leases"],
      ["crashInjection"],
    ) !== undefined &&
    snapshotRecord(config["workspaceUsageLimits"], [
      "byteLimit",
      "entryLimit",
      "scanLimit",
    ]) !== undefined &&
    snapshotArray(config["commandProfiles"], maximumTargets) !== undefined &&
    snapshotRecord(config["approvalContext"], [
      "taskId",
      "principalId",
      "operation",
    ]) !== undefined
  );
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  const snapshot = snapshotRecord(value, methods);
  return (
    snapshot !== undefined &&
    methods.every((method) => typeof snapshot[method] === "function")
  );
}

function isContextBudget(value: unknown): value is ContextBudgetAuthorityPort {
  return hasMethods(value, ["reserve"]);
}

function isPhysicalIntegration(
  value: unknown,
): value is PhysicalIntegrationAuthorityPort {
  return hasMethods(value, ["attest"]);
}
