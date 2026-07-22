import { digestValue } from "../../digest.ts";
import { snapshotRecord } from "../../engineering/session/snapshot.ts";
import { isExecutionCommandCatalog } from "./catalog.ts";
import type {
  AgentlessAdvanceResult,
  AgentlessExecutor,
  AgentlessExecutorCreationResult,
  AgentlessSession,
  AgentlessStage,
  AgentlessTask,
  ExecutionCommandCatalog,
  StableCommandRequest,
} from "./contract.ts";
import { snapshotCommand, validDigest, validIdentifier } from "./validation.ts";

interface AgentlessRecord {
  readonly owner: object;
  readonly task: AgentlessTask;
  readonly executionId: AgentlessSession["executionId"];
  readonly stage: AgentlessStage;
  readonly version: number;
  state: "active" | "running" | "sealed";
}

const sessions = new WeakSet<object>();
const records = new WeakMap<object, AgentlessRecord>();
const executors = new WeakSet<object>();

export function createAgentlessExecutor(
  catalog: unknown,
): AgentlessExecutorCreationResult {
  if (!isExecutionCommandCatalog(catalog)) {
    return Object.freeze({
      status: "rejected" as const,
      code: "UNTRUSTED_COMMAND_CATALOG" as const,
    });
  }
  const owner = Object.freeze({});
  let sequence = 0;
  const executor: AgentlessExecutor = Object.freeze({
    schema: "skizzles.orchestrator/agentless-executor/v1" as const,
    start(input: unknown) {
      const task = snapshotTask(input);
      if (task === undefined) {
        return Object.freeze({
          status: "rejected" as const,
          code: "INVALID_AGENTLESS_TASK" as const,
        });
      }
      sequence += 1;
      const executionId = digestValue({
        schema: "skizzles.orchestrator/agentless-execution/v1",
        task,
        sequence,
      });
      return Object.freeze({
        status: "started" as const,
        session: createSession(owner, task, executionId, "locate", 0),
      });
    },
    advance: (input: unknown) => advanceAgentless(owner, catalog, input),
  });
  executors.add(executor);
  return Object.freeze({ status: "created" as const, executor });
}

export function isAgentlessExecutor(
  value: unknown,
): value is AgentlessExecutor {
  return typeof value === "object" && value !== null && executors.has(value);
}

export function isAgentlessSession(value: unknown): value is AgentlessSession {
  return typeof value === "object" && value !== null && sessions.has(value);
}

async function advanceAgentless(
  owner: object,
  catalog: ExecutionCommandCatalog,
  input: unknown,
): Promise<AgentlessAdvanceResult> {
  const request = snapshotRecord(input, ["session"]);
  if (request === undefined || !isAgentlessSession(request["session"])) {
    return rejected("INVALID_AGENTLESS_ADVANCE");
  }
  const current = request["session"];
  const record = records.get(current);
  if (
    record === undefined ||
    record.owner !== owner ||
    record.state !== "active"
  ) {
    return rejected("AGENTLESS_SESSION_STALE");
  }
  record.state = "running";
  const result = await catalog.execute(commandFor(record));
  records.delete(current);
  if (result.status !== "completed") {
    record.state = "sealed";
    return rejected("COMMAND_REJECTED");
  }
  record.state = "sealed";
  if (result.observation.exitCode !== 0) {
    return Object.freeze({
      status: "failed" as const,
      failedStage: record.stage,
      observation: result.observation,
      executionId: record.executionId,
    });
  }
  if (record.stage === "verify") {
    return Object.freeze({
      status: "completed" as const,
      completedStage: "verify" as const,
      observation: result.observation,
      executionId: record.executionId,
    });
  }
  const nextStage = record.stage === "locate" ? "patch" : "verify";
  return Object.freeze({
    status: "advanced" as const,
    completedStage: record.stage,
    observation: result.observation,
    session: createSession(
      owner,
      record.task,
      record.executionId,
      nextStage,
      record.version + 1,
    ),
  });
}

function createSession(
  owner: object,
  task: AgentlessTask,
  executionId: AgentlessSession["executionId"],
  stage: AgentlessStage,
  version: number,
): AgentlessSession {
  const session: AgentlessSession = Object.freeze({
    executionId,
    taskId: task.taskId,
    objectiveDigest: task.objectiveDigest,
    stage,
    version,
  });
  sessions.add(session);
  records.set(session, {
    owner,
    task,
    executionId,
    stage,
    version,
    state: "active",
  });
  return session;
}

function snapshotTask(value: unknown): AgentlessTask | undefined {
  const task = snapshotRecord(value, [
    "taskId",
    "objectiveDigest",
    "locate",
    "patch",
    "verify",
  ]);
  if (
    task === undefined ||
    !validIdentifier(task["taskId"]) ||
    !validDigest(task["objectiveDigest"])
  )
    return;
  const locate = snapshotCommand(task["locate"]);
  const patch = snapshotCommand(task["patch"]);
  const verify = snapshotCommand(task["verify"]);
  if (
    locate === undefined ||
    (locate.command !== "locate.symbol" && locate.command !== "locate.text") ||
    patch?.command !== "patch.apply" ||
    verify?.command !== "verify.tests"
  )
    return;
  return Object.freeze({
    taskId: task["taskId"],
    objectiveDigest: task["objectiveDigest"],
    locate,
    patch,
    verify,
  });
}

function commandFor(record: AgentlessRecord): StableCommandRequest {
  switch (record.stage) {
    case "locate":
      return record.task.locate;
    case "patch":
      return record.task.patch;
    case "verify":
      return record.task.verify;
  }
}

function rejected(
  code: Extract<AgentlessAdvanceResult, { status: "rejected" }>["code"],
): AgentlessAdvanceResult {
  return Object.freeze({ status: "rejected" as const, code });
}
