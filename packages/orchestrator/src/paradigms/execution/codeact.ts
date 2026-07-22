import { snapshotRecord } from "../../engineering/snapshot.ts";
import type {
  CodeActExecutionResult,
  CodeActExecutor,
  CodeActExecutorCreationResult,
  CodeActSandboxCapability,
  SandboxCapabilityCreationResult,
} from "./contract.ts";
import {
  snapshotObservation,
  snapshotSandboxRequest,
  validIdentifier,
} from "./validation.ts";

interface SandboxState {
  readonly authorityId: string;
  readonly receiver: unknown;
  readonly execute: AuthorityMethod;
}

type AuthorityMethod = (...arguments_: never[]) => unknown;

const sandboxes = new WeakMap<object, SandboxState>();
const executors = new WeakSet<object>();

export function createCodeActSandboxCapability(
  value: unknown,
): SandboxCapabilityCreationResult {
  const authority = snapshotRecord(value, ["authorityId", "execute"]);
  if (
    authority === undefined ||
    !validIdentifier(authority["authorityId"]) ||
    !isAuthorityMethod(authority["execute"])
  ) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_SANDBOX_AUTHORITY" as const,
    });
  }
  const capability: CodeActSandboxCapability = Object.freeze({
    schema: "skizzles.orchestrator/codeact-sandbox-capability/v1" as const,
    authorityId: authority["authorityId"],
  });
  sandboxes.set(
    capability,
    Object.freeze({
      authorityId: authority["authorityId"],
      receiver: value,
      execute: authority["execute"],
    }),
  );
  return Object.freeze({ status: "created" as const, capability });
}

export function isCodeActSandboxCapability(
  value: unknown,
): value is CodeActSandboxCapability {
  return typeof value === "object" && value !== null && sandboxes.has(value);
}

export function createCodeActExecutor(
  capability: unknown,
): CodeActExecutorCreationResult {
  if (!isCodeActSandboxCapability(capability)) {
    return Object.freeze({
      status: "rejected" as const,
      code: "UNTRUSTED_SANDBOX" as const,
    });
  }
  const executor: CodeActExecutor = Object.freeze({
    schema: "skizzles.orchestrator/codeact-executor/v1" as const,
    authorityId: sandboxes.get(capability)?.authorityId ?? "unreachable",
    execute: (request: unknown) => executeCodeAct(capability, request),
  });
  executors.add(executor);
  return Object.freeze({ status: "created" as const, executor });
}

export function isCodeActExecutor(value: unknown): value is CodeActExecutor {
  return typeof value === "object" && value !== null && executors.has(value);
}

async function executeCodeAct(
  capability: CodeActSandboxCapability,
  raw: unknown,
): Promise<CodeActExecutionResult> {
  const request = snapshotSandboxRequest(raw);
  if (request === undefined) return rejected("INVALID_CODEACT_REQUEST");
  const state = sandboxes.get(capability);
  if (state === undefined) return rejected("SANDBOX_AUTHORITY_FAILED");
  let output: unknown;
  try {
    output = await Reflect.apply(state.execute, state.receiver, [request]);
  } catch {
    return rejected("SANDBOX_AUTHORITY_FAILED");
  }
  const observation = snapshotObservation(output);
  if (observation === undefined) return rejected("INVALID_SANDBOX_OUTPUT");
  return Object.freeze({
    status: "completed" as const,
    executionId: request.executionId,
    observation,
  });
}

function rejected(
  code: Extract<CodeActExecutionResult, { status: "rejected" }>["code"],
): CodeActExecutionResult {
  return Object.freeze({ status: "rejected" as const, code });
}

function isAuthorityMethod(value: unknown): value is AuthorityMethod {
  return typeof value === "function";
}
