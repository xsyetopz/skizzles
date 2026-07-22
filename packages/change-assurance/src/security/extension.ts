import { types } from "node:util";
import type {
  ChangeAssuranceExtensionCreationResult,
  ChangeAssuranceExtensionInput,
  ChangeAssuranceExtensionResult,
} from "../contract.ts";
import {
  createChangeAssuranceExtension,
  isChangeAssuranceExtension,
} from "../extension.ts";
import type {
  SecurityAssuranceExtension,
  SecurityPolicyConfig,
  SessionBoundaryConfig,
  SessionBoundaryRuntime,
  SessionBoundaryTarget,
} from "./contract.ts";
import { digestBytes, digestValue } from "./digest.ts";
import { analyzeSecurityCandidates } from "./policy/analyze.ts";
import { parseSecurityPolicyConfig } from "./policy/config.ts";
import {
  createSessionBoundaryAuthority,
  isSessionBoundaryRuntime,
} from "./session.ts";

interface SecuritySessionConfig {
  readonly config: SessionBoundaryConfig;
  readonly runtime: SessionBoundaryRuntime;
}

interface SecurityExtensionConfig {
  readonly id: string;
  readonly version: string;
  readonly policy: SecurityPolicyConfig;
  readonly session?: SecuritySessionConfig;
}

export function createSecurityAssuranceExtension(
  input: unknown,
): ChangeAssuranceExtensionCreationResult {
  const config = parseExtensionConfig(input);
  if (config === undefined) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_EXTENSION_CONFIG",
    });
  }
  return createChangeAssuranceExtension({
    domain: "middleware-security",
    id: config.id,
    version: config.version,
    assess: async (assessment: ChangeAssuranceExtensionInput) =>
      assessSecurityExtension(assessment, config),
  });
}

export function isSecurityAssuranceExtension(
  value: unknown,
): value is SecurityAssuranceExtension {
  return (
    isChangeAssuranceExtension(value) &&
    Reflect.get(value, "domain") === "middleware-security"
  );
}

export async function assessSecurityExtension(
  assessment: ChangeAssuranceExtensionInput,
  configInput: unknown,
): Promise<ChangeAssuranceExtensionResult> {
  const config = parseExtensionConfig(configInput);
  if (config === undefined)
    return Object.freeze({
      status: "rejected",
      code: "INVALID_SECURITY_CONFIG",
    });
  const policy = await analyzeSecurityCandidates(assessment, config.policy);
  if (policy.status === "rejected") {
    return Object.freeze({
      status: "rejected",
      code: "SECURITY_POLICY_REJECTED",
    });
  }
  let sessionEvidenceDigest: string | null = null;
  if (config.session !== undefined) {
    const sessionResult = await inspectSessionBoundary(
      assessment,
      config.session,
    );
    if (sessionResult.status === "rejected") {
      return Object.freeze({ status: "rejected", code: sessionResult.code });
    }
    sessionEvidenceDigest = sessionResult.evidenceDigest;
  }
  return Object.freeze({
    status: "accepted",
    evidenceDigest: digestValue({
      policyEvidenceDigest: policy.evidenceDigest,
      sessionEvidenceDigest,
    }),
  });
}

async function inspectSessionBoundary(
  assessment: ChangeAssuranceExtensionInput,
  config: SecuritySessionConfig,
): Promise<
  | Readonly<{ status: "accepted"; evidenceDigest: string }>
  | Readonly<{ status: "rejected"; code: string }>
> {
  const targets: SessionBoundaryTarget[] = [];
  for (const target of assessment.targets) {
    if (target.candidateBytes === null) {
      return Object.freeze({
        status: "rejected",
        code: "SESSION_BOUNDARY_REJECTED",
      });
    }
    const candidateBytes = Object.freeze([...target.candidateBytes]);
    targets.push(
      Object.freeze({
        path: target.path,
        candidateDigest: digestBytes(Uint8Array.from(candidateBytes)),
        candidateBytes,
      }),
    );
  }
  const frozenTargets = Object.freeze(targets);
  const authorityResult = createSessionBoundaryAuthority(config.config);
  if (authorityResult.status === "rejected") {
    return Object.freeze({ status: "rejected", code: authorityResult.code });
  }
  const bound = authorityResult.authority.bindTargets(frozenTargets);
  if (bound.status === "rejected") {
    return Object.freeze({
      status: "rejected",
      code: "SESSION_BOUNDARY_FORGED",
    });
  }
  const input = Object.freeze({
    candidateTargets: bound.targets,
    runtime: config.runtime,
  });
  const receipt = await authorityResult.authority.inspect(input);
  return receipt.status === "accepted"
    ? Object.freeze({
        status: "accepted",
        evidenceDigest: receipt.evidenceDigest,
      })
    : Object.freeze({
        status: "rejected",
        code: receipt.code ?? "SESSION_BOUNDARY_REJECTED",
      });
}

function parseExtensionConfig(
  input: unknown,
): SecurityExtensionConfig | undefined {
  const record = optionalRecord(
    input,
    ["id", "version", "policy", "session"],
    ["id", "version", "policy"],
  );
  if (record === undefined) return;
  const id = record.get("id");
  const version = record.get("version");
  const policy = parseSecurityPolicyConfig(record.get("policy"));
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 128 ||
    typeof version !== "string" ||
    version.length === 0 ||
    version.length > 64 ||
    policy === undefined
  )
    return;
  const sessionValue = record.get("session");
  const session =
    sessionValue === undefined ? undefined : parseSessionConfig(sessionValue);
  const sessionRequired =
    policy.secureInterfaces.some(
      ({ capability }) => capability === "session",
    ) ||
    policy.auditedImports.some(({ capability }) => capability === "session");
  if (
    (sessionValue !== undefined && session === undefined) ||
    (sessionRequired && session === undefined)
  )
    return;
  return Object.freeze({
    id,
    version,
    policy,
    ...(session === undefined ? {} : { session }),
  });
}

function parseSessionConfig(value: unknown): SecuritySessionConfig | undefined {
  const record = exactRecord(value, ["config", "runtime"]);
  if (record === undefined) return;
  const config = record.get("config");
  const runtime = record.get("runtime");
  if (
    !isSessionBoundaryRuntime(runtime) ||
    typeof config !== "object" ||
    config === null
  )
    return;
  const configRecord = exactRecord(config, [
    "requiredRole",
    "maximumSessionAgeMs",
    "refreshWindowMs",
  ]);
  if (configRecord === undefined) return;
  const requiredRole = configRecord.get("requiredRole");
  const maximumSessionAgeMs = configRecord.get("maximumSessionAgeMs");
  const refreshWindowMs = configRecord.get("refreshWindowMs");
  if (
    typeof requiredRole !== "string" ||
    requiredRole.length === 0 ||
    typeof maximumSessionAgeMs !== "number" ||
    !Number.isInteger(maximumSessionAgeMs) ||
    maximumSessionAgeMs <= 0 ||
    typeof refreshWindowMs !== "number" ||
    !Number.isInteger(refreshWindowMs) ||
    refreshWindowMs <= 0 ||
    refreshWindowMs > maximumSessionAgeMs
  )
    return;
  return Object.freeze({
    config: Object.freeze({
      requiredRole,
      maximumSessionAgeMs,
      refreshWindowMs,
    }),
    runtime,
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return;
  const result = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    result.set(key, descriptor.value);
  }
  return result;
}

function optionalRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return;
  const own = Reflect.ownKeys(value);
  if (
    own.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !own.includes(key))
  )
    return;
  const result = new Map<string, unknown>();
  for (const key of own) {
    if (typeof key !== "string") return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    result.set(key, descriptor.value);
  }
  return result;
}
