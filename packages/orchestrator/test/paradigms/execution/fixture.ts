import { digestValue } from "../../../src/digest.ts";
import { createExecutionCommandCatalog } from "../../../src/paradigms/execution/catalog.ts";
import {
  createCodeActExecutor,
  createCodeActSandboxCapability,
} from "../../../src/paradigms/execution/codeact.ts";
import {
  type AgentlessTask,
  type CodeActExecutor,
  type ExecutionCommandCatalog,
  type StableCommandRequest,
} from "../../../src/paradigms/execution/contract.ts";

export interface CatalogHarness {
  readonly catalog: ExecutionCommandCatalog;
  readonly executor: CodeActExecutor;
  readonly commands: StableCommandRequest[];
}

export function createCatalogHarness(
  execute: (
    request: StableCommandRequest,
  ) => unknown | Promise<unknown> = () => ({
    stdout: "ok",
    stderr: "",
    exitCode: 0,
  }),
): CatalogHarness {
  const commands: StableCommandRequest[] = [];
  const pending = new Map<string, StableCommandRequest>();
  let sequence = 0;
  const run = (request: StableCommandRequest) => {
    commands.push(request);
    sequence += 1;
    const executionId = `fixture-${sequence}`;
    pending.set(executionId, request);
    return Object.freeze({
      executionId,
      language: "typescript" as const,
      source: `command:${request.command}`,
      workingDirectory: "packages/orchestrator",
      timeoutMilliseconds: 30_000,
    });
  };
  const capability = createCodeActSandboxCapability({
    authorityId: "fixture-codeact-sandbox",
    execute: (request: { readonly executionId: string }) => {
      const command = pending.get(request.executionId);
      if (command === undefined) throw new Error("unknown fixture execution");
      pending.delete(request.executionId);
      return execute(command);
    },
  });
  if (capability.status !== "created") throw new Error("sandbox setup failed");
  const codeAct = createCodeActExecutor(capability.capability);
  if (codeAct.status !== "created") throw new Error("executor setup failed");
  const created = createExecutionCommandCatalog(
    {
      authorityId: "fixture-command-authority",
      locateSymbol: run,
      locateText: run,
      applyPatch: run,
      verifyTests: run,
    },
    codeAct.executor,
  );
  if (created.status !== "created") {
    throw new Error("catalog setup failed");
  }
  return { catalog: created.catalog, executor: codeAct.executor, commands };
}

export function agentlessTask(taskId = "task-a"): AgentlessTask {
  return Object.freeze({
    taskId,
    objectiveDigest: digestValue(`objective:${taskId}`),
    locate: Object.freeze({
      command: "locate.symbol" as const,
      root: "packages/orchestrator",
      symbol: "EngineeringWorkflow",
    }),
    patch: Object.freeze({
      command: "patch.apply" as const,
      patchDigest: digestValue(`patch:${taskId}`),
      paths: Object.freeze(["packages/orchestrator/src/index.ts"]),
    }),
    verify: Object.freeze({
      command: "verify.tests" as const,
      testIds: Object.freeze(["orchestrator:focused"]),
    }),
  });
}
