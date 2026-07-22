import { type Digest, digestValue } from "../../digest.ts";
import type {
  SchedulerDispatchRequest,
  SchedulerWorkerAuthority,
  SchedulerWorkerAuthorityCreationResult,
  SchedulerWorkerResult,
} from "./contract.ts";

const authorities = new WeakSet<object>();
const dispatchRequests = new WeakSet<object>();
const maximumAuthorityIdLength = 128;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;

export function createSchedulerWorkerAuthority(
  input: unknown,
): SchedulerWorkerAuthorityCreationResult {
  const config = parseConfig(input);
  if (config === undefined) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_WORKER_AUTHORITY",
    });
  }
  const authority: SchedulerWorkerAuthority = Object.freeze({
    authorityId: config.authorityId,
    async dispatch(
      request: SchedulerDispatchRequest,
    ): Promise<SchedulerWorkerResult> {
      if (!dispatchRequests.has(request)) {
        return internalFailure(
          digestValue("untrusted-scheduler-dispatch-request"),
          "UNTRUSTED_DISPATCH_REQUEST",
        );
      }
      dispatchRequests.delete(request);
      let raw: unknown;
      try {
        raw = await config.dispatch(request);
      } catch {
        return internalFailure(request.bindingDigest, "WORKER_EXCEPTION");
      }
      return (
        parseResult(raw, request.bindingDigest) ??
        internalFailure(request.bindingDigest, "INVALID_WORKER_RESULT")
      );
    },
  });
  authorities.add(authority);
  return Object.freeze({ status: "created", authority });
}

export function issueSchedulerDispatchRequest(
  input: SchedulerDispatchRequest,
): SchedulerDispatchRequest {
  const request = Object.freeze(input);
  dispatchRequests.add(request);
  return request;
}

export function isSchedulerWorkerAuthority(
  value: unknown,
): value is SchedulerWorkerAuthority {
  return typeof value === "object" && value !== null && authorities.has(value);
}

function parseConfig(input: unknown):
  | Readonly<{
      authorityId: string;
      dispatch: (
        request: SchedulerDispatchRequest,
      ) => unknown | Promise<unknown>;
    }>
  | undefined {
  if (typeof input !== "object" || input === null) return;
  try {
    if (!Object.isFrozen(input)) return;
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== 2 ||
      !keys.includes("authorityId") ||
      !keys.includes("dispatch")
    ) {
      return;
    }
    const authorityId = Object.getOwnPropertyDescriptor(input, "authorityId");
    const dispatch = Object.getOwnPropertyDescriptor(input, "dispatch");
    if (
      authorityId === undefined ||
      dispatch === undefined ||
      !("value" in authorityId) ||
      !("value" in dispatch) ||
      typeof authorityId.value !== "string" ||
      authorityId.value.length === 0 ||
      authorityId.value.length > maximumAuthorityIdLength ||
      typeof dispatch.value !== "function"
    ) {
      return;
    }
    return Object.freeze({
      authorityId: authorityId.value,
      dispatch: dispatch.value,
    });
  } catch {
    return;
  }
}

function parseResult(
  value: unknown,
  bindingDigest: Digest,
): SchedulerWorkerResult | undefined {
  if (typeof value !== "object" || value === null) return;
  try {
    if (!Object.isFrozen(value)) return;
    const status = data(value, "status");
    const binding = data(value, "bindingDigest");
    const evidenceDigest = data(value, "evidenceDigest");
    if (
      binding !== bindingDigest ||
      typeof evidenceDigest !== "string" ||
      !digestPattern.test(evidenceDigest)
    ) {
      return;
    }
    if (status === "completed" || status === "cancelled") {
      if (!exactKeys(value, ["bindingDigest", "evidenceDigest", "status"]))
        return;
      return Object.freeze({
        status,
        bindingDigest,
        evidenceDigest: evidenceDigest as Digest,
      });
    }
    const code = data(value, "code");
    if (
      status !== "failed" ||
      typeof code !== "string" ||
      !codePattern.test(code) ||
      !exactKeys(value, ["bindingDigest", "code", "evidenceDigest", "status"])
    ) {
      return;
    }
    return Object.freeze({
      status,
      bindingDigest,
      code,
      evidenceDigest: evidenceDigest as Digest,
    });
  } catch {
    return;
  }
}

function internalFailure(
  bindingDigest: Digest,
  code: string,
): SchedulerWorkerResult {
  return Object.freeze({
    status: "failed",
    bindingDigest,
    code,
    evidenceDigest: digestValue({ bindingDigest, code }),
  });
}

function data(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return;
  return descriptor.value;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}
