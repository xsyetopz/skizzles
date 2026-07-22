import { expect, it } from "bun:test";
import { createLocalRepositoryLeaseAuthority } from "@skizzles/workspace-publication";
import type { CausalWorkflow } from "../../src/workflow/causal/contract.ts";
import { createCausalWorkflow } from "../../src/workflow/causal/create.ts";
import { createTestTaskWorktree } from "../engineering/worktree/fixture.ts";
import { createHarness } from "../facade/support.ts";
import { createTestWorkflowVerificationAuthority } from "../facade/verification-fixture.ts";
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
  prepare: ["request", "repository", "targets", "discoveryRoot", "profileIds"],
  approveAndPromote: ["review", "token"],
  reject: ["review"],
  recover: ["handle"],
  retryCleanup: ["handle"],
};

function createWorkflow(): Readonly<{
  workflow: CausalWorkflow;
  cleanup: () => void;
}> {
  const { orchestrator } = createHarness();
  const destination = new IsolatedDestination();
  const taskFixture = createTestTaskWorktree();
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
    taskWorktree: taskFixture.taskWorktree,
    taskWorktreeApproval: taskFixture.taskWorktreeApproval,
    verificationAuthority: createTestWorkflowVerificationAuthority(),
    verificationProfiles: {
      originalTests: "verify-original-tests",
      mutation: "verify-mutation",
      property: "verify-property",
      coverage: "verify-coverage",
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
    approvalContext: {
      taskId: "hostile-input",
      principalId: "maintainer-a",
      operation: "publish",
    },
  });
  if (created.status !== "accepted") {
    taskFixture.cleanup();
    throw new Error("valid hostile-input workflow fixture rejected");
  }
  return Object.freeze({
    workflow: created.workflow,
    cleanup: taskFixture.cleanup,
  });
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
  const fixture = createWorkflow();
  try {
    expect(Object.keys(fixture.workflow)).toEqual([...operations]);
    const calls = operations.flatMap((operation) =>
      [
        trappingProxy(),
        revokedProxy(),
        getterInput(operation),
        Symbol(operation),
      ].map(async (input) => ({
        operation,
        result: await fixture.workflow[operation](input),
      })),
    );
    for (const { operation, result } of await Promise.all(calls)) {
      expect(result).toEqual(expected(operation));
    }
  } finally {
    fixture.cleanup();
  }
});
