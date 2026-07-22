import type {
  AssuranceJsonValue,
  ChangeAssuranceDomain,
  ChangeDeclaration,
  ChangeDeclarationCreationResult,
  ChangeDeclarationTarget,
} from "./contract.ts";
import { digestValue, isDigest } from "./digest.ts";
import { cloneJson } from "./json.ts";
import { normalizeTargetPath } from "./path.ts";

export const assuranceDomains = Object.freeze([
  "middleware-security",
  "migration-configuration-secrets",
  "performance",
  "supply-chain",
] satisfies readonly ChangeAssuranceDomain[]);

interface DeclarationBindings {
  readonly targets: readonly ChangeDeclarationTarget[];
  readonly plans: Readonly<Record<ChangeAssuranceDomain, AssuranceJsonValue>>;
}

const declarations = new WeakMap<object, DeclarationBindings>();

export function createChangeDeclaration(
  input: unknown,
): ChangeDeclarationCreationResult {
  let parsed: ReturnType<typeof parseDeclarationInput>;
  try {
    parsed = parseDeclarationInput(input);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return { status: "rejected", code: "INVALID_DECLARATION" };
  }
  const targetSetDigest = digestValue(parsed.targets);
  const planDigests = Object.freeze({
    "middleware-security": digestValue(parsed.plans["middleware-security"]),
    "migration-configuration-secrets": digestValue(
      parsed.plans["migration-configuration-secrets"],
    ),
    performance: digestValue(parsed.plans.performance),
    "supply-chain": digestValue(parsed.plans["supply-chain"]),
  });
  const material = Object.freeze({
    requestDigest: parsed.requestDigest,
    repositoryId: parsed.repositoryId,
    targetSetDigest,
    planDigests,
  });
  const declaration: ChangeDeclaration = Object.freeze({
    ...material,
    declarationDigest: digestValue(material),
  });
  declarations.set(declaration, {
    targets: parsed.targets,
    plans: parsed.plans,
  });
  return { status: "created", declaration };
}

export function isChangeDeclaration(
  input: unknown,
): input is ChangeDeclaration {
  return typeof input === "object" && input !== null && declarations.has(input);
}

export function declarationBindings(
  declaration: ChangeDeclaration,
): DeclarationBindings | undefined {
  return declarations.get(declaration);
}

function parseDeclarationInput(input: unknown):
  | {
      readonly requestDigest: ReturnType<typeof digestValue>;
      readonly repositoryId: string;
      readonly targets: readonly ChangeDeclarationTarget[];
      readonly plans: Readonly<
        Record<ChangeAssuranceDomain, AssuranceJsonValue>
      >;
    }
  | undefined {
  if (
    !exactRecord(input, ["requestDigest", "repositoryId", "targets", "plans"])
  ) {
    return;
  }
  if (
    !isDigest(input["requestDigest"]) ||
    typeof input["repositoryId"] !== "string" ||
    input["repositoryId"].length === 0 ||
    input["repositoryId"].length > 256 ||
    !Array.isArray(input["targets"]) ||
    input["targets"].length === 0 ||
    input["targets"].length > 256 ||
    !exactRecord(input["plans"], assuranceDomains)
  ) {
    return;
  }
  const targets: ChangeDeclarationTarget[] = [];
  const paths = new Set<string>();
  for (const raw of input["targets"]) {
    if (!exactRecord(raw, ["path", "operation"])) {
      return;
    }
    const path = normalizeTargetPath(raw["path"]);
    if (
      path === undefined ||
      paths.has(path) ||
      (raw["operation"] !== "write" && raw["operation"] !== "delete")
    ) {
      return;
    }
    paths.add(path);
    targets.push(Object.freeze({ path, operation: raw["operation"] }));
  }
  targets.sort((left, right) => left.path.localeCompare(right.path));
  const plans: Partial<Record<ChangeAssuranceDomain, AssuranceJsonValue>> = {};
  for (const domain of assuranceDomains) {
    const plan = cloneJson(input["plans"][domain]);
    if (plan === undefined) {
      return;
    }
    plans[domain] = plan;
  }
  const middlewareSecurity = plans["middleware-security"];
  const migrationConfigurationSecrets =
    plans["migration-configuration-secrets"];
  const performance = plans.performance;
  const supplyChain = plans["supply-chain"];
  if (
    middlewareSecurity === undefined ||
    migrationConfigurationSecrets === undefined ||
    performance === undefined ||
    supplyChain === undefined
  ) {
    return;
  }
  return Object.freeze({
    requestDigest: input["requestDigest"],
    repositoryId: input["repositoryId"],
    targets: Object.freeze(targets),
    plans: Object.freeze({
      "middleware-security": middlewareSecurity,
      "migration-configuration-secrets": migrationConfigurationSecrets,
      performance,
      "supply-chain": supplyChain,
    }),
  });
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): input is Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input)
  ) {
    return false;
  }
  const own = Reflect.ownKeys(input);
  return (
    own.length === keys.length &&
    own.every((key) => typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}

import { types } from "node:util";
