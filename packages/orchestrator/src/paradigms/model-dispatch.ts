import { digestValue } from "../digest.ts";
import type {
  ModelDispatchAuthority,
  ModelDispatchAuthorityCreationResult,
  ModelDispatchRequest,
} from "./runtime-contract.ts";

type RawDispatch = (
  request: ModelDispatchRequest,
) => unknown | Promise<unknown>;

const authorities = new WeakSet<object>();
const requests = new WeakSet<object>();
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;

export function createModelDispatchAuthority(
  input: unknown,
): ModelDispatchAuthorityCreationResult {
  const config = parseConfig(input);
  if (config === undefined) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_MODEL_DISPATCH_AUTHORITY" as const,
    });
  }
  const authority: ModelDispatchAuthority = Object.freeze({
    schema: "skizzles.orchestrator/model-dispatch-authority/v1" as const,
    authorityId: config.authorityId,
    dispatch: async (request: ModelDispatchRequest) => {
      if (
        typeof request !== "object" ||
        request === null ||
        !requests.has(request) ||
        request.authorityId !== config.authorityId
      ) {
        throw new TypeError("untrusted model dispatch request");
      }
      return await config.dispatch(request);
    },
  });
  authorities.add(authority);
  return Object.freeze({ status: "created" as const, authority });
}

export function isModelDispatchAuthority(
  value: unknown,
): value is ModelDispatchAuthority {
  return typeof value === "object" && value !== null && authorities.has(value);
}

export function createModelDispatchRequest(
  input: Omit<ModelDispatchRequest, "requestDigest" | "schema">,
): ModelDispatchRequest {
  const body = Object.freeze({
    schema: "skizzles.orchestrator/model-dispatch-request/v1" as const,
    ...input,
  });
  const request: ModelDispatchRequest = Object.freeze({
    ...body,
    requestDigest: digestValue(body),
  });
  requests.add(request);
  return request;
}

function parseConfig(
  input: unknown,
): Readonly<{ authorityId: string; dispatch: RawDispatch }> | undefined {
  if (typeof input !== "object" || input === null || !Object.isFrozen(input)) {
    return;
  }
  try {
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
      !("value" in authorityId && "value" in dispatch) ||
      typeof authorityId.value !== "string" ||
      !identifierPattern.test(authorityId.value) ||
      typeof dispatch.value !== "function"
    ) {
      return;
    }
    return Object.freeze({
      authorityId: authorityId.value,
      dispatch: dispatch.value as RawDispatch,
    });
  } catch {
    return;
  }
}
