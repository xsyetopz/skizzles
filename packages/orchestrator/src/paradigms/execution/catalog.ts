import { snapshotRecord } from "../../engineering/session/snapshot.ts";
import { isCodeActExecutor } from "./codeact.ts";
import type {
  CodeActExecutor,
  CommandCatalogCreationResult,
  CommandExecutionResult,
  ExecutionCommandCatalog,
  StableCommandName,
  StableCommandRequest,
} from "./contract.ts";
import {
  snapshotCommand,
  snapshotSandboxRequest,
  validIdentifier,
} from "./validation.ts";

const catalogs = new WeakSet<object>();
const commandNames: readonly StableCommandName[] = Object.freeze([
  "locate.symbol",
  "locate.text",
  "patch.apply",
  "verify.tests",
]);
type AuthorityMethod = (...arguments_: never[]) => unknown;

export function createExecutionCommandCatalog(
  value: unknown,
  executor: unknown,
): CommandCatalogCreationResult {
  if (!isCodeActExecutor(executor)) {
    return Object.freeze({
      status: "rejected" as const,
      code: "UNTRUSTED_CODEACT_EXECUTOR" as const,
    });
  }
  const authority = snapshotRecord(value, [
    "authorityId",
    "locateSymbol",
    "locateText",
    "applyPatch",
    "verifyTests",
  ]);
  if (
    authority === undefined ||
    !validIdentifier(authority["authorityId"]) ||
    !isAuthorityMethod(authority["locateSymbol"]) ||
    !isAuthorityMethod(authority["locateText"]) ||
    !isAuthorityMethod(authority["applyPatch"]) ||
    !isAuthorityMethod(authority["verifyTests"])
  ) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_COMMAND_AUTHORITY" as const,
    });
  }
  const receiver = value;
  const methods = Object.freeze({
    locateSymbol: authority["locateSymbol"],
    locateText: authority["locateText"],
    applyPatch: authority["applyPatch"],
    verifyTests: authority["verifyTests"],
  });
  const catalog: ExecutionCommandCatalog = Object.freeze({
    schema: "skizzles.orchestrator/execution-command-catalog/v1" as const,
    authorityId: authority["authorityId"],
    commands: commandNames,
    execute: (request: unknown) =>
      executeCommand(receiver, methods, executor, request),
  });
  catalogs.add(catalog);
  return Object.freeze({ status: "created" as const, catalog });
}

export function isExecutionCommandCatalog(
  value: unknown,
): value is ExecutionCommandCatalog {
  return typeof value === "object" && value !== null && catalogs.has(value);
}

async function executeCommand(
  receiver: unknown,
  methods: Readonly<{
    locateSymbol: AuthorityMethod;
    locateText: AuthorityMethod;
    applyPatch: AuthorityMethod;
    verifyTests: AuthorityMethod;
  }>,
  executor: CodeActExecutor,
  raw: unknown,
): Promise<CommandExecutionResult> {
  const request = snapshotCommand(raw);
  if (request === undefined) return rejected("INVALID_COMMAND");
  let output: unknown;
  try {
    output = await invokeCommand(receiver, methods, request);
  } catch {
    return rejected("COMMAND_AUTHORITY_FAILED");
  }
  const sandboxRequest = snapshotSandboxRequest(output);
  if (sandboxRequest === undefined) return rejected("INVALID_COMMAND_OUTPUT");
  const executed = await executor.execute(sandboxRequest);
  if (executed.status !== "completed") {
    return rejected("COMMAND_AUTHORITY_FAILED");
  }
  return Object.freeze({
    status: "completed" as const,
    command: request.command,
    observation: executed.observation,
  });
}

function invokeCommand(
  receiver: unknown,
  methods: Readonly<{
    locateSymbol: AuthorityMethod;
    locateText: AuthorityMethod;
    applyPatch: AuthorityMethod;
    verifyTests: AuthorityMethod;
  }>,
  request: StableCommandRequest,
): unknown | Promise<unknown> {
  switch (request.command) {
    case "locate.symbol":
      return Reflect.apply(methods.locateSymbol, receiver, [request]);
    case "locate.text":
      return Reflect.apply(methods.locateText, receiver, [request]);
    case "patch.apply":
      return Reflect.apply(methods.applyPatch, receiver, [request]);
    case "verify.tests":
      return Reflect.apply(methods.verifyTests, receiver, [request]);
  }
}

function rejected(
  code: Extract<CommandExecutionResult, { status: "rejected" }>["code"],
): CommandExecutionResult {
  return Object.freeze({ status: "rejected" as const, code });
}

function isAuthorityMethod(value: unknown): value is AuthorityMethod {
  return typeof value === "function";
}
