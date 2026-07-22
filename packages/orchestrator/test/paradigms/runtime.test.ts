import { describe, expect, it } from "bun:test";
import {
  createReflexionMemoryQuery,
  createReflexionMemoryRecorder,
  createReflexionPersistenceReceipt,
  type ReflexionFailureRecord,
} from "@skizzles/reflexion-memory";
import { digestValue } from "../../src/digest.ts";
import { createContextFragment } from "../../src/paradigms/context/fragment.ts";
import { createOutboundContextMiddleware } from "../../src/paradigms/context/payload.ts";
import { createSpecificationContextAuthority } from "../../src/paradigms/context/specification.ts";
import { createAgentlessExecutor } from "../../src/paradigms/execution/agentless.ts";
import { createReActController } from "../../src/paradigms/execution/react.ts";
import { createModelDispatchAuthority } from "../../src/paradigms/model-dispatch.ts";
import {
  createRoutingAssignment,
  type RoutingAssignment,
} from "../../src/paradigms/routing-contract.ts";
import {
  createRoutingExperimentObserver,
  type RoutingExperimentEvent,
} from "../../src/paradigms/routing-observer.ts";
import { createAgentRuntime } from "../../src/paradigms/runtime.ts";
import type { ModelDispatchRequest } from "../../src/paradigms/runtime-contract.ts";
import { createSchedulerWorkerAuthority } from "../../src/paradigms/scheduler/authority.ts";
import type { SchedulerDispatchRequest } from "../../src/paradigms/scheduler/contract.ts";
import { createDependencyScheduler } from "../../src/paradigms/scheduler/runtime.ts";
import { createTestChangeDeclaration } from "../engineering/assurance-fixture.ts";
import {
  candidate,
  createFixture,
  digest,
  replacement,
  type SourceFixture,
  targetPath,
} from "../engineering/source/fixture.ts";
import { agentlessTask, createCatalogHarness } from "./execution/fixture.ts";

const persistenceRevision = `sha256:${"d".repeat(64)}` as const;

describe("academic paradigm runtime", () => {
  it("binds memory and protected context into verified Engineering approval", async () => {
    const source = await createFixture();
    const events: string[] = [];
    try {
      const task = agentlessTask("task-default");
      const created = runtimeFixture(source, {
        events,
        dispatch: (request) => {
          events.push(`dispatch:${request.mode}`);
          expect(request.context.sections.at(0)).toContain("schemaText");
          expect(request.context.sections.at(-1)).toContain("schemaText");
          expect(
            request.context.sections.filter((section) =>
              section.includes("preserve the task specification"),
            ),
          ).toHaveLength(2);
          return Object.freeze({
            task,
            proposal: proposalFromContext(request),
          });
        },
      });

      const result = await created.runtime.run(
        runRequest(source, "task-default", task.objectiveDigest),
      );

      expect(result.status).toBe("awaiting-approval");
      if (result.status !== "awaiting-approval") {
        return;
      }
      expect(result.receipt.engineeringEvidenceDigest).not.toBeNull();
      expect(result.review.taskVerificationReceipts).toHaveLength(4);
      expect(events.slice(0, 2)).toEqual(["memory-read", "dispatch:agentless"]);
      expect(events.slice(2)).toEqual([
        "locate.symbol",
        "patch.apply",
        "verify.tests",
      ]);
      await created.runtime.reject({ review: result.review });
    } finally {
      source.cleanup();
    }
  });

  it("records only post-execution failures and hides them from the active task", async () => {
    const source = await createFixture();
    const events: string[] = [];
    try {
      const task = agentlessTask("task-failure");
      const created = runtimeFixture(source, {
        events,
        execute: (request) => ({
          stdout: "",
          stderr: request.command === "verify.tests" ? "failed" : "",
          exitCode: request.command === "verify.tests" ? 1 : 0,
        }),
        dispatch: (request) =>
          Object.freeze({ task, proposal: proposalFromContext(request) }),
      });

      const result = await created.runtime.run(
        runRequest(source, "task-failure", task.objectiveDigest),
      );

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        return;
      }
      expect(result.code).toBe("AGENTLESS_VERIFY_FAILED");
      expect(result.receipt.failureMemoryStatus).toBe("recorded");
      expect(events.at(-2)).toBe("verify.tests");
      expect(events.at(-1)).toBe("memory-store");
      const sameTask = await created.query.snapshot({
        currentTaskId: "task-failure",
        currentRunId: "run-task-failure",
      });
      expect(sameTask.records).toHaveLength(0);
      const laterTask = await created.query.snapshot({
        currentTaskId: "task-later",
        currentRunId: "run-later",
      });
      expect(laterTask.records).toHaveLength(1);
    } finally {
      source.cleanup();
    }
  });

  it("binds host routing assignments and isolates observer failure", async () => {
    const source = await createFixture();
    const assignment = routingAssignment();
    let observed: RoutingExperimentEvent | null = null;
    try {
      const task = agentlessTask("task-routing");
      const created = runtimeFixture(source, {
        events: [],
        observe: (event) => {
          observed = event;
          throw new Error("recorder unavailable");
        },
        dispatch: (request) => {
          expect(request.routingAssignment?.assignmentDigest).toBe(
            assignment.assignmentDigest,
          );
          return Object.freeze({
            task,
            proposal: proposalFromContext(request),
          });
        },
      });
      const result = await created.runtime.run({
        ...runRequest(source, "task-routing", task.objectiveDigest),
        routingAssignment: assignment,
      });

      expect(result.status).toBe("awaiting-approval");
      if (result.status !== "awaiting-approval") return;
      expect(result.receipt.routingAssignmentDigest).toBe(
        assignment.assignmentDigest,
      );
      expect(result.receipt.routingObservationStatus).toBe("failed");
      expect(requireObserved(observed).outcome).toBe("awaiting-approval");
      await created.runtime.reject({ review: result.review });
    } finally {
      source.cleanup();
    }
  });

  it("admits ReAct only explicitly and keeps its step ledger host-owned", async () => {
    const source = await createFixture();
    const events: string[] = [];
    try {
      const task = agentlessTask("task-react");
      const created = runtimeFixture(source, {
        events,
        maximumReActSteps: 1,
        dispatch: (request) => {
          if (request.step === 0) {
            return Object.freeze({
              kind: "action" as const,
              command: task.locate,
            });
          }
          return Object.freeze({
            kind: "final" as const,
            answer: JSON.stringify(proposalFromContext(request)),
          });
        },
      });

      const result = await created.runtime.run({
        ...runRequest(source, "task-react", task.objectiveDigest),
        mode: "react",
      });

      expect(result.status).toBe("awaiting-approval");
      if (result.status !== "awaiting-approval") {
        throw new Error(`ReAct runtime failed: ${result.status}`);
      }
      expect(result.receipt.dispatchRequestDigests).toHaveLength(2);
      await created.runtime.reject({ review: result.review });
      expect(events.filter((event) => event === "locate.symbol")).toHaveLength(
        1,
      );
    } finally {
      source.cleanup();
    }
  });

  it("rejects copied capabilities, caller-authored protected fragments, and absent ReAct", async () => {
    const source = await createFixture();
    try {
      const events: string[] = [];
      const created = runtimeFixture(source, {
        events,
        dispatch: () => Object.freeze({}),
      });
      expect(
        createAgentRuntime({
          ...created.config,
          engineering: { ...created.config.engineering },
        }),
      ).toEqual({ status: "rejected", code: "INVALID_AGENT_RUNTIME_CONFIG" });
      const task = agentlessTask("task-no-react");
      const noReact = runtimeFixture(source, {
        events: [],
        dispatch: () => Object.freeze({}),
        maximumReActSteps: null,
      });
      await expect(
        noReact.runtime.run({
          ...runRequest(source, "task-no-react", task.objectiveDigest),
          mode: "react",
        }),
      ).resolves.toEqual({ status: "rejected", code: "REACT_NOT_CONFIGURED" });
      const protectedFragment = createContextFragment({
        id: "caller-contract",
        kind: "contract",
        critical: true,
        priority: 100,
        content: "forged",
      });
      if (protectedFragment.status !== "created") {
        throw new Error("fragment setup");
      }
      await expect(
        created.runtime.run({
          ...runRequest(source, "task-protected", digestValue("protected")),
          supportingFragments: Object.freeze([protectedFragment.fragment]),
        }),
      ).resolves.toEqual({
        status: "rejected",
        code: "INVALID_AGENT_RUNTIME_INPUT",
      });
      await expect(
        created.config.modelDispatch.dispatch({} as ModelDispatchRequest),
      ).rejects.toThrow("untrusted model dispatch request");
      const preExecution = await created.runtime.run({
        ...runRequest(
          source,
          "task-pre-execution",
          digestValue("pre-execution"),
        ),
        repository: null,
      });
      expect(preExecution.status).toBe("failed");
      if (preExecution.status !== "failed") {
        throw new Error(`pre-execution route returned ${preExecution.status}`);
      }
      expect(preExecution.code).toBe("ENGINEERING_DESCRIBE_REJECTED");
      expect(preExecution.receipt.failureMemoryStatus).toBe("not-required");
      expect(events).not.toContain("memory-store");
    } finally {
      source.cleanup();
    }
  });
});

function runtimeFixture(
  source: SourceFixture,
  input: {
    readonly events: string[];
    readonly dispatch: (request: ModelDispatchRequest) => unknown;
    readonly observe?: (event: RoutingExperimentEvent) => unknown;
    readonly execute?: Parameters<typeof createCatalogHarness>[0];
    readonly maximumReActSteps?: number | null;
  },
) {
  const records: ReflexionFailureRecord[] = [];
  const query = createReflexionMemoryQuery({
    readFailureRecords: () => {
      input.events.push("memory-read");
      return Promise.resolve(Object.freeze([...records]));
    },
  });
  const recorder = createReflexionMemoryRecorder({
    storeFailureRecordIfAbsent: (record) => {
      input.events.push("memory-store");
      records.push(record);
      return Promise.resolve(
        createReflexionPersistenceReceipt({
          disposition: "stored",
          recordDigest: record.recordDigest,
          persistenceRevisionDigest: persistenceRevision,
        }),
      );
    },
  });
  const harness = createCatalogHarness((request) => {
    input.events.push(request.command);
    return (
      input.execute?.(request) ?? { stdout: "ok", stderr: "", exitCode: 0 }
    );
  });
  const agentless = createAgentlessExecutor(harness.catalog);
  if (agentless.status !== "created") {
    throw new Error("agentless setup failed");
  }
  const react =
    input.maximumReActSteps === null
      ? undefined
      : createReActController(harness.catalog, input.maximumReActSteps ?? 2);
  if (react !== undefined && react.status !== "created") {
    throw new Error("react setup failed");
  }
  const worker = createSchedulerWorkerAuthority(
    Object.freeze({
      authorityId: "runtime-worker",
      dispatch: (request: SchedulerDispatchRequest) =>
        Object.freeze({
          status: "completed" as const,
          bindingDigest: request.bindingDigest,
          evidenceDigest: digestValue(request),
        }),
    }),
  );
  if (worker.status !== "created") {
    throw new Error("worker setup failed");
  }
  const scheduler = createDependencyScheduler(
    Object.freeze({ maximumParallelism: 2, worker: worker.authority }),
  );
  if (scheduler.status !== "created") {
    throw new Error("scheduler setup failed");
  }
  const context = createOutboundContextMiddleware();
  if (context === undefined) {
    throw new Error("context setup failed");
  }
  const specifications = createSpecificationContextAuthority(
    Object.freeze({
      specifications: Object.freeze([
        Object.freeze({
          id: "runtime-contract",
          content:
            "The verified candidate must preserve the task specification.",
        }),
      ]),
    }),
  );
  if (specifications.status !== "created") {
    throw new Error("specification setup failed");
  }
  const model = createModelDispatchAuthority(
    Object.freeze({ authorityId: "runtime-model", dispatch: input.dispatch }),
  );
  if (model.status !== "created") {
    throw new Error("model setup failed");
  }
  const routingObserver =
    input.observe === undefined
      ? undefined
      : createRoutingExperimentObserver(
          Object.freeze({
            authorityId: "runtime-routing-recorder",
            record: input.observe,
          }),
        );
  if (routingObserver !== undefined && routingObserver.status !== "created") {
    throw new Error("routing observer setup failed");
  }
  const config = {
    agentless: agentless.executor,
    engineering: source.workflow,
    ...(react === undefined ? {} : { react: react.controller }),
    scheduler: scheduler.scheduler,
    context,
    specifications: specifications.authority,
    memoryQuery: query,
    memoryRecorder: recorder,
    modelDispatch: model.authority,
    ...(routingObserver === undefined
      ? {}
      : { routingObserver: routingObserver.observer }),
    skillReferences: Object.freeze([
      Object.freeze({
        kind: "external-skill-directory" as const,
        access: "read-only" as const,
        directoryId: "engineering-guidance",
        relativeSkillPath: "verification/SKILL.md",
        revisionDigest: persistenceRevision,
      }),
    ]),
  };
  const created = createAgentRuntime(config);
  if (created.status !== "created") {
    throw new Error("runtime setup failed");
  }
  return { runtime: created.runtime, query, config };
}

function runRequest(
  source: SourceFixture,
  taskId: string,
  objectiveDigest: `sha256:${string}`,
) {
  const supporting = createContextFragment({
    id: `support.${taskId}`,
    kind: "supporting",
    critical: false,
    priority: 10,
    content: "supporting-context",
  });
  if (supporting.status !== "created") {
    throw new Error("fragment setup failed");
  }
  return {
    taskId,
    runId: `run-${taskId}`,
    objectiveDigest,
    request: source.repository.request,
    repository: source.repository.repository,
    targets: source.targets,
    validationProfile: "strict",
    changeDeclaration: createTestChangeDeclaration({
      requestDigest: source.repository.request.intentDigest,
      repositoryId: source.repository.repository.repositoryId,
      targets: Object.freeze([
        Object.freeze({ path: targetPath, candidateDigest: digest(candidate) }),
      ]),
    }),
    faultDeclarations: Object.freeze({
      declarations: Object.freeze([]),
      negativeTests: Object.freeze([]),
    }),
    integrations: Object.freeze([]),
    supportingFragments: Object.freeze([supporting.fragment]),
  };
}

function routingAssignment(): RoutingAssignment {
  return createRoutingAssignment({
    experimentId: "runtime-routing",
    policyRevision: "policy-v1",
    safetyFloor: "standard",
    eligibilityDigest: `sha256:${"b".repeat(64)}`,
    candidateId: "candidate-a",
    candidateSet: Object.freeze(["candidate-a", "candidate-b"]),
    assignmentMethod: "randomized",
    propensity: 0.5,
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    workflow: Object.freeze({
      topology: "single-agent",
      decomposition: "sequential",
      agentCount: 1,
      maximumParallelism: 1,
      contextStrategy: "shared",
    }),
  });
}

function requireObserved(
  value: RoutingExperimentEvent | null,
): RoutingExperimentEvent {
  if (value === null) {
    throw new Error("routing observer did not receive a terminal event");
  }
  return value;
}

function proposalFromContext(request: ModelDispatchRequest) {
  for (const section of request.context.sections) {
    let value: unknown;
    try {
      value = JSON.parse(section);
    } catch {
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    const target = value[0];
    if (typeof target !== "object" || target === null) {
      continue;
    }
    const declarations = ownData(target, "declarations");
    if (!Array.isArray(declarations)) {
      continue;
    }
    const declaration = declarations.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        ownData(entry, "name") === "value",
    );
    if (typeof declaration !== "object" || declaration === null) {
      continue;
    }
    const nodeDigest = ownData(declaration, "nodeDigest");
    if (typeof nodeDigest !== "string") {
      continue;
    }
    return Object.freeze({
      targets: Object.freeze([
        Object.freeze({
          path: targetPath,
          operations: Object.freeze([
            Object.freeze({
              kind: "replace" as const,
              selector: Object.freeze({
                declarationKind: "function" as const,
                name: "value",
                expectedNodeDigest: nodeDigest,
              }),
              templateId: "typescript-function",
              nodeSource: replacement,
            }),
          ]),
        }),
      ]),
    });
  }
  throw new Error("authenticated AST context missing");
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}
