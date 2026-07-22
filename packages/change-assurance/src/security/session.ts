import { types } from "node:util";
import type {
  SessionBoundaryAuthority,
  SessionBoundaryAuthorityCreationResult,
  SessionBoundaryCaseReceipt,
  SessionBoundaryConfig,
  SessionBoundaryInput,
  SessionBoundaryOperation,
  SessionBoundaryReceipt,
  SessionBoundaryRuntime,
  SessionBoundaryRuntimeResult,
  SessionBoundaryTarget,
  SessionProbeObservation,
  SessionProbeRequest,
} from "./contract.ts";
import { digestBytes, digestValue } from "./digest.ts";

const authorities = new WeakSet<object>();
const authorityConfigs = new WeakMap<object, SessionBoundaryConfig>();
const boundTargets = new WeakSet<object>();
const runtimes = new WeakMap<
  object,
  (request: SessionProbeRequest) => Promise<SessionProbeObservation>
>();
const operations: readonly SessionBoundaryOperation[] = [
  "expiry",
  "refresh",
  "logout",
  "role",
  "unauthorized",
  "unavailable",
];

export function createSessionBoundaryAuthority(
  input: unknown,
): SessionBoundaryAuthorityCreationResult {
  const config = parseConfig(input);
  if (config === undefined)
    return Object.freeze({ status: "rejected", code: "INVALID_CONFIG" });
  let authority: SessionBoundaryAuthority;
  authority = Object.freeze({
    bindTargets: (targets: readonly SessionBoundaryTarget[]) => bind(targets),
    inspect: (value: SessionBoundaryInput) => inspect(authority, value),
  });
  authorities.add(authority);
  authorityConfigs.set(authority, config);
  return Object.freeze({ status: "created", authority });
}

export function isSessionBoundaryAuthority(
  value: unknown,
): value is SessionBoundaryAuthority {
  return typeof value === "object" && value !== null && authorities.has(value);
}

export function createSessionBoundaryRuntime(
  dispatch: unknown,
): SessionBoundaryRuntimeResult {
  if (typeof dispatch !== "function")
    return Object.freeze({ status: "rejected", code: "INVALID_RUNTIME" });
  const runtimeDispatch = async (
    request: SessionProbeRequest,
  ): Promise<SessionProbeObservation> => {
    const result = await Promise.resolve(
      Reflect.apply(dispatch, undefined, [request]),
    );
    if (!validObservation(result))
      throw new Error("session runtime returned an invalid observation");
    return result;
  };
  const runtime: SessionBoundaryRuntime = Object.freeze({
    dispatch: runtimeDispatch,
  });
  runtimes.set(runtime, runtimeDispatch);
  return Object.freeze({ status: "created", runtime });
}

export function isSessionBoundaryRuntime(
  value: unknown,
): value is SessionBoundaryRuntime {
  return typeof value === "object" && value !== null && runtimes.has(value);
}

async function inspect(
  authority: SessionBoundaryAuthority,
  input: SessionBoundaryInput,
): Promise<SessionBoundaryReceipt> {
  const config = authorityConfigs.get(authority);
  if (
    config === undefined ||
    !validInput(input) ||
    !boundTargets.has(input.candidateTargets)
  ) {
    return rejected("SESSION_BOUNDARY_FORGED", []);
  }
  const runtimeDispatch = runtimes.get(input.runtime);
  if (runtimeDispatch === undefined)
    return rejected("SESSION_BOUNDARY_FORGED", []);
  const candidateSetDigest = digestValue(
    input.candidateTargets.map(({ path, candidateDigest }) => ({
      path,
      candidateDigest,
    })),
  );
  const caseReceipts: SessionBoundaryCaseReceipt[] = [];
  for (const operation of operations) {
    const scenario = timingScenario(operation, config);
    const request = Object.freeze({
      operation,
      candidateTargets: input.candidateTargets,
      ...scenario,
    });
    let observation: SessionProbeObservation;
    try {
      observation = await runtimeDispatch(request);
    } catch {
      return rejected(
        "SESSION_BOUNDARY_REJECTED",
        caseReceipts,
        candidateSetDigest,
      );
    }
    if (
      !(
        validObservation(observation) &&
        expected(operation, observation, config)
      )
    ) {
      return rejected(
        "SESSION_BOUNDARY_REJECTED",
        caseReceipts,
        candidateSetDigest,
      );
    }
    caseReceipts.push(
      Object.freeze({
        operation,
        requestDigest: digestValue({
          operation,
          candidateSetDigest,
          ...scenario,
        }),
        observationDigest: digestValue(observation),
      }),
    );
  }
  return Object.freeze({
    status: "accepted",
    caseReceipts: Object.freeze(caseReceipts),
    candidateSetDigest,
    evidenceDigest: digestValue({
      version: "session-boundary-v1",
      config,
      candidateSetDigest,
      caseReceipts,
    }),
  });
}

function timingScenario(
  operation: SessionBoundaryOperation,
  config: SessionBoundaryConfig,
): Readonly<{ sessionAgeMs: number; remainingLifetimeMs: number }> {
  if (operation === "expiry") {
    return Object.freeze({
      sessionAgeMs: config.maximumSessionAgeMs,
      remainingLifetimeMs: 0,
    });
  }
  if (operation === "refresh") {
    return Object.freeze({
      sessionAgeMs: config.maximumSessionAgeMs - config.refreshWindowMs,
      remainingLifetimeMs: config.refreshWindowMs,
    });
  }
  return Object.freeze({
    sessionAgeMs: 0,
    remainingLifetimeMs: config.maximumSessionAgeMs,
  });
}

function bind(
  targets: readonly SessionBoundaryTarget[],
):
  | Readonly<{ status: "bound"; targets: readonly SessionBoundaryTarget[] }>
  | Readonly<{ status: "rejected"; code: "INVALID_TARGETS" }> {
  if (!validTargets(targets))
    return Object.freeze({ status: "rejected", code: "INVALID_TARGETS" });
  boundTargets.add(targets);
  return Object.freeze({ status: "bound", targets });
}

function validInput(input: unknown): input is SessionBoundaryInput {
  const record = exactRecord(input, ["candidateTargets", "runtime"]);
  const candidateTargets = record?.get("candidateTargets");
  const runtime = record?.get("runtime");
  return (
    record !== undefined &&
    typeof input === "object" &&
    input !== null &&
    Object.isFrozen(input) &&
    isFrozenObject(candidateTargets) &&
    validTargets(candidateTargets) &&
    isSessionBoundaryRuntime(runtime)
  );
}

function validTargets(
  value: unknown,
): value is readonly SessionBoundaryTarget[] {
  if (!Array.isArray(value) || types.isProxy(value)) return false;
  const targets = value;
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.length > 256 ||
    !Object.isFrozen(targets)
  )
    return false;
  const paths = new Set<string>();
  for (const target of targets) {
    const record = exactRecord(target, [
      "path",
      "candidateDigest",
      "candidateBytes",
    ]);
    const path = record?.get("path");
    const candidateDigest = record?.get("candidateDigest");
    const candidateBytes = record?.get("candidateBytes");
    if (
      record === undefined ||
      !Object.isFrozen(target) ||
      !isFrozenObject(candidateBytes) ||
      !validPath(path) ||
      paths.has(path) ||
      !digest(candidateDigest) ||
      !validBytes(candidateBytes)
    )
      return false;
    if (digestBytes(Uint8Array.from(candidateBytes)) !== candidateDigest)
      return false;
    paths.add(path);
  }
  return true;
}

function validBytes(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    !types.isProxy(value) &&
    value.length <= 16_777_216 &&
    value.every(
      (item) =>
        typeof item === "number" &&
        Number.isInteger(item) &&
        item >= 0 &&
        item <= 255,
    )
  );
}

function validObservation(value: unknown): value is SessionProbeObservation {
  const record = optionalRecord(
    value,
    ["decision", "state", "role"],
    ["decision", "state"],
  );
  if (record === undefined) return false;
  const decision = record.get("decision");
  const state = record.get("state");
  const role = record.get("role");
  return (
    (decision === "allow" ||
      decision === "deny" ||
      decision === "expired" ||
      decision === "unavailable") &&
    (state === "active" ||
      state === "refreshed" ||
      state === "expired" ||
      state === "logged-out" ||
      state === "absent") &&
    (role === undefined || typeof role === "string")
  );
}

function expected(
  operation: SessionBoundaryOperation,
  observation: SessionProbeObservation,
  config: SessionBoundaryConfig,
): boolean {
  const { decision, state, role } = observation;
  if (operation === "expiry")
    return decision === "expired" && state === "expired";
  if (operation === "refresh")
    return decision === "allow" && state === "refreshed";
  if (operation === "logout")
    return (
      state === "logged-out" && (decision === "allow" || decision === "deny")
    );
  if (operation === "role")
    return decision === "allow" && role === config.requiredRole;
  if (operation === "unauthorized")
    return decision === "deny" && (state === "absent" || state === "active");
  return decision === "unavailable";
}

function parseConfig(input: unknown): SessionBoundaryConfig | undefined {
  const record = exactRecord(input, [
    "requiredRole",
    "maximumSessionAgeMs",
    "refreshWindowMs",
  ]);
  if (record === undefined) return;
  const requiredRole = record.get("requiredRole");
  const maximumSessionAgeMs = record.get("maximumSessionAgeMs");
  const refreshWindowMs = record.get("refreshWindowMs");
  if (
    typeof requiredRole !== "string" ||
    requiredRole.length === 0 ||
    requiredRole.length > 128 ||
    typeof maximumSessionAgeMs !== "number" ||
    !Number.isInteger(maximumSessionAgeMs) ||
    maximumSessionAgeMs <= 0 ||
    typeof refreshWindowMs !== "number" ||
    !Number.isInteger(refreshWindowMs) ||
    refreshWindowMs <= 0 ||
    refreshWindowMs > maximumSessionAgeMs
  )
    return;
  return Object.freeze({ requiredRole, maximumSessionAgeMs, refreshWindowMs });
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

function isFrozenObject(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    !types.isProxy(value) &&
    Object.isFrozen(value)
  );
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\0") &&
    !value.split("/").some((part) => part === ".." || part === "")
  );
}

function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function rejected(
  code: "SESSION_BOUNDARY_REJECTED" | "SESSION_BOUNDARY_FORGED",
  caseReceipts: readonly SessionBoundaryCaseReceipt[],
  candidateSetDigest = digestValue({ code }),
): SessionBoundaryReceipt {
  return Object.freeze({
    status: "rejected",
    code,
    caseReceipts: Object.freeze([...caseReceipts]),
    candidateSetDigest,
    evidenceDigest: digestValue({ code, candidateSetDigest, caseReceipts }),
  });
}
