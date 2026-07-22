// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { expect, it } from "bun:test";
import process from "node:process";
import { createLocalRepositoryLeaseAuthority } from "@skizzles/workspace-transaction";
import { createCausalWorkflow } from "../../src/workflow/causal-workflow.ts";
import type { CausalWorkflow } from "../../src/workflow/contract.ts";
import { createHarness } from "../support.ts";
import { IsolatedDestination } from "./isolated-destination.ts";

type WorkflowOperation = keyof CausalWorkflow;
type InvalidWorkflowResult =
  | Readonly<{
      status: "rejected";
      code: "INVALID_WORKFLOW_INPUT";
    }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_WORKFLOW_INPUT";
      cleanup: null;
    }>;

const operations = Object.freeze([
  "prepare",
  "approveAndPromote",
  "reject",
  "recover",
  "retryCleanup",
] satisfies readonly WorkflowOperation[]);

const inputKeys: Readonly<Record<WorkflowOperation, readonly string[]>> = {
  prepare: ["request", "repository", "targets", "discoveryRoot", "commands"],
  approveAndPromote: ["review", "token"],
  reject: ["review"],
  recover: ["handle"],
  retryCleanup: ["handle"],
};

function createWorkflow(): CausalWorkflow {
  const { orchestrator } = createHarness();
  const destination = new IsolatedDestination();
  const created = createCausalWorkflow({
    orchestrator,
    publicationIdentity: {
      repositoryId: "repo-a",
      rootIdentity: "root-a",
      ownerId: "worker-a",
    },
    baselineAuthority: {
      capture(): never {
        throw new Error(
          "hostile-input tests must stop before baseline capture",
        );
      },
    },
    transaction: {
      destination,
      leases: createLocalRepositoryLeaseAuthority([
        {
          repositoryId: "repo-a",
          rootIdentity: "root-a",
          ownerId: "worker-a",
        },
      ]),
    },
    workspaceUsageLimits: {
      byteLimit: 1000,
      entryLimit: 10,
      scanLimit: 10,
    },
    commandProfiles: [
      {
        id: "validate",
        argv: [process.execPath, "-e", "process.exit(0)"],
        env: {},
        timeoutMilliseconds: 1000,
        maximumOutputBytes: 1000,
        drainMilliseconds: 100,
        signalGraceMilliseconds: 100,
        allowedExitCodes: [0],
        stderr: "must-be-empty",
      },
    ],
    approvalContext: {
      taskId: "hostile-input",
      principalId: "maintainer-a",
      operation: "publish",
    },
  });
  if (created.status !== "accepted") {
    throw new Error("valid hostile-input workflow fixture rejected");
  }
  return created.workflow;
}

function getterInput(operation: WorkflowOperation): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const key of inputKeys[operation]) {
    Object.defineProperty(value, key, {
      enumerable: true,
      get: (): unknown => {
        throw new Error(`hostile ${operation} getter`);
      },
    });
  }
  return value;
}

function trappingProxy(): Record<string, never> {
  return new Proxy<Record<string, never>>(
    {},
    {
      getOwnPropertyDescriptor: (): PropertyDescriptor | undefined => {
        throw new Error("hostile workflow proxy");
      },
    },
  );
}

function revokedProxy(): Record<string, never> {
  const revoked = Proxy.revocable<Record<string, never>>({}, {});
  revoked.revoke();
  return revoked.proxy;
}

function expected(operation: WorkflowOperation): InvalidWorkflowResult {
  const base = {
    status: "rejected",
    code: "INVALID_WORKFLOW_INPUT",
  } as const;
  if (
    operation === "prepare" ||
    operation === "approveAndPromote" ||
    operation === "reject"
  ) {
    return { ...base, cleanup: null };
  }
  return base;
}

it("rejects hostile inputs at every public workflow operation", async () => {
  const workflow = createWorkflow();
  expect(Object.keys(workflow)).toEqual([...operations]);
  const calls = operations.flatMap((operation) =>
    [
      trappingProxy(),
      revokedProxy(),
      getterInput(operation),
      Symbol(operation),
    ].map(async (input) => ({
      operation,
      result: await workflow[operation](input),
    })),
  );
  for (const { operation, result } of await Promise.all(calls)) {
    expect(result).toEqual(expected(operation));
  }
});
