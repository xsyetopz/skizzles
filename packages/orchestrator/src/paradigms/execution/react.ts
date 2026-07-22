import { digestValue } from "../../digest.ts";
import { snapshotRecord } from "../../engineering/snapshot.ts";
import { isExecutionCommandCatalog } from "./catalog.ts";
import type {
  ExecutionCommandCatalog,
  ReActAdvanceResult,
  ReActController,
  ReActControllerCreationResult,
  ReActSession,
  ReActTurn,
} from "./contract.ts";
import { snapshotCommand, validDigest, validIdentifier } from "./validation.ts";

interface ReActRecord {
  readonly owner: object;
  readonly sessionId: ReActSession["sessionId"];
  readonly taskId: string;
  readonly objectiveDigest: ReActSession["objectiveDigest"];
  readonly step: number;
  readonly maximumSteps: number;
  state: "active" | "running" | "sealed";
}

const controllers = new WeakSet<object>();
const sessions = new WeakSet<object>();
const records = new WeakMap<object, ReActRecord>();

export function createReActController(
  catalog: unknown,
  maximumSteps: unknown,
): ReActControllerCreationResult {
  if (!isExecutionCommandCatalog(catalog)) {
    return Object.freeze({
      status: "rejected" as const,
      code: "UNTRUSTED_COMMAND_CATALOG" as const,
    });
  }
  if (
    typeof maximumSteps !== "number" ||
    !Number.isSafeInteger(maximumSteps) ||
    maximumSteps < 1 ||
    maximumSteps > 64
  ) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_REACT_CONFIG" as const,
    });
  }
  const owner = Object.freeze({});
  let sequence = 0;
  const controller: ReActController = Object.freeze({
    schema: "skizzles.orchestrator/react-controller/v1" as const,
    maximumSteps,
    start(input: unknown) {
      const task = snapshotRecord(input, ["taskId", "objectiveDigest"]);
      if (
        task === undefined ||
        !validIdentifier(task["taskId"]) ||
        !validDigest(task["objectiveDigest"])
      ) {
        return Object.freeze({
          status: "rejected" as const,
          code: "INVALID_REACT_TASK" as const,
        });
      }
      sequence += 1;
      const sessionId = digestValue({
        schema: "skizzles.orchestrator/react-session/v1",
        taskId: task["taskId"],
        objectiveDigest: task["objectiveDigest"],
        sequence,
      });
      return Object.freeze({
        status: "started" as const,
        session: createSession({
          owner,
          sessionId,
          taskId: task["taskId"],
          objectiveDigest: task["objectiveDigest"],
          step: 0,
          maximumSteps,
          state: "active",
        }),
      });
    },
    advance: (input: unknown) => advanceReAct(owner, catalog, input),
  });
  controllers.add(controller);
  return Object.freeze({ status: "created" as const, controller });
}

export function isReActController(value: unknown): value is ReActController {
  return typeof value === "object" && value !== null && controllers.has(value);
}

export function isReActSession(value: unknown): value is ReActSession {
  return typeof value === "object" && value !== null && sessions.has(value);
}

async function advanceReAct(
  owner: object,
  catalog: ExecutionCommandCatalog,
  input: unknown,
): Promise<ReActAdvanceResult> {
  const request = snapshotRecord(input, ["session", "turn"]);
  if (request === undefined || !isReActSession(request["session"])) {
    return rejected("INVALID_REACT_TURN");
  }
  const current = request["session"];
  const record = records.get(current);
  if (
    record === undefined ||
    record.owner !== owner ||
    record.state !== "active"
  ) {
    return rejected("REACT_SESSION_STALE");
  }
  const turn = snapshotTurn(request["turn"]);
  if (turn === undefined) return rejected("INVALID_REACT_TURN");
  if (turn.kind === "final") {
    record.state = "sealed";
    records.delete(current);
    return Object.freeze({
      status: "completed" as const,
      answer: turn.answer,
      sessionId: record.sessionId,
      steps: record.step,
    });
  }
  if (record.step >= record.maximumSteps) {
    record.state = "sealed";
    records.delete(current);
    return rejected("REACT_STEP_BUDGET_EXHAUSTED");
  }
  record.state = "running";
  const result = await catalog.execute(turn.command);
  records.delete(current);
  record.state = "sealed";
  if (result.status !== "completed") return rejected("COMMAND_REJECTED");
  return Object.freeze({
    status: "observed" as const,
    observation: result.observation,
    session: createSession({
      ...record,
      step: record.step + 1,
      state: "active",
    }),
  });
}

function createSession(record: ReActRecord): ReActSession {
  const session: ReActSession = Object.freeze({
    sessionId: record.sessionId,
    taskId: record.taskId,
    objectiveDigest: record.objectiveDigest,
    step: record.step,
    maximumSteps: record.maximumSteps,
  });
  sessions.add(session);
  records.set(session, record);
  return session;
}

function snapshotTurn(value: unknown): ReActTurn | undefined {
  const discriminator = snapshotRecord(value, ["kind"], ["command", "answer"]);
  if (discriminator?.["kind"] === "action") {
    const turn = snapshotRecord(value, ["kind", "command"]);
    const command = snapshotCommand(turn?.["command"]);
    if (turn === undefined || command === undefined) return;
    return Object.freeze({ kind: "action" as const, command });
  }
  if (discriminator?.["kind"] === "final") {
    const turn = snapshotRecord(value, ["kind", "answer"]);
    if (turn === undefined || !validIdentifier(turn["answer"], 16_384)) return;
    return Object.freeze({ kind: "final" as const, answer: turn["answer"] });
  }
  return undefined;
}

function rejected(
  code: Extract<ReActAdvanceResult, { status: "rejected" }>["code"],
): ReActAdvanceResult {
  return Object.freeze({ status: "rejected" as const, code });
}
