import { describe, expect, it } from "bun:test";
import { digestValue } from "../../../src/digest.ts";
import {
  createReActController,
  isReActSession,
} from "../../../src/paradigms/execution/react.ts";
import { createCatalogHarness } from "./fixture.ts";

describe("host-owned ReAct middleware", () => {
  it("records actions in private loop state and lets the host finalize", async () => {
    const harness = createCatalogHarness((request) => ({
      stdout: `observed:${request.command}`,
      stderr: "",
      exitCode: 0,
    }));
    const created = createReActController(harness.catalog, 3);
    if (created.status !== "created") {
      throw new Error("controller setup failed");
    }
    const started = created.controller.start({
      taskId: "task-react",
      objectiveDigest: digestValue("react-objective"),
    });
    if (started.status !== "started") throw new Error("start failed");
    expect(isReActSession(started.session)).toBe(true);
    expect(started.session).toMatchObject({ step: 0, maximumSteps: 3 });
    const observed = await created.controller.advance({
      session: started.session,
      turn: {
        kind: "action",
        command: {
          command: "locate.text",
          root: "packages/orchestrator",
          query: "workflow",
        },
      },
    });
    expect(observed).toMatchObject({
      status: "observed",
      session: { step: 1, maximumSteps: 3 },
      observation: { stdout: "observed:locate.text" },
    });
    if (observed.status !== "observed") return;
    const completed = await created.controller.advance({
      session: observed.session,
      turn: { kind: "final", answer: "The change is verified." },
    });
    expect(completed).toMatchObject({
      status: "completed",
      answer: "The change is verified.",
      steps: 1,
    });
  });

  it("allows a final turn at the boundary but rejects another action", async () => {
    const harness = createCatalogHarness();
    const created = createReActController(harness.catalog, 1);
    if (created.status !== "created") {
      throw new Error("controller setup failed");
    }
    const start = (taskId: string) =>
      created.controller.start({
        taskId,
        objectiveDigest: digestValue(taskId),
      });
    const finalPath = start("final-path");
    if (finalPath.status !== "started") throw new Error("start failed");
    const observed = await created.controller.advance({
      session: finalPath.session,
      turn: {
        kind: "action",
        command: { command: "verify.tests", testIds: ["focused"] },
      },
    });
    if (observed.status !== "observed") throw new Error("action failed");
    await expect(
      created.controller.advance({
        session: observed.session,
        turn: { kind: "final", answer: "done" },
      }),
    ).resolves.toMatchObject({ status: "completed", steps: 1 });

    const exhaustedPath = start("exhausted-path");
    if (exhaustedPath.status !== "started") throw new Error("start failed");
    const first = await created.controller.advance({
      session: exhaustedPath.session,
      turn: {
        kind: "action",
        command: { command: "verify.tests", testIds: ["focused"] },
      },
    });
    if (first.status !== "observed") throw new Error("action failed");
    await expect(
      created.controller.advance({
        session: first.session,
        turn: {
          kind: "action",
          command: { command: "verify.tests", testIds: ["again"] },
        },
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "REACT_STEP_BUDGET_EXHAUSTED",
    });
    expect(harness.commands).toHaveLength(2);
  });

  it("rejects forged loop counters, stale sessions, and invalid generic tools", async () => {
    const harness = createCatalogHarness();
    const created = createReActController(harness.catalog, 2);
    if (created.status !== "created") {
      throw new Error("controller setup failed");
    }
    const started = created.controller.start({
      taskId: "host-owned",
      objectiveDigest: digestValue("host-owned"),
    });
    if (started.status !== "started") throw new Error("start failed");
    await expect(
      created.controller.advance({
        session: { ...started.session, step: 0, maximumSteps: 1_000_000 },
        turn: { kind: "final", answer: "forged" },
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "INVALID_REACT_TURN",
    });
    await expect(
      created.controller.advance({
        session: started.session,
        turn: { kind: "action", command: { command: "shell", text: "pwd" } },
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "INVALID_REACT_TURN",
    });
    const completed = await created.controller.advance({
      session: started.session,
      turn: { kind: "final", answer: "safe" },
    });
    expect(completed.status).toBe("completed");
    await expect(
      created.controller.advance({
        session: started.session,
        turn: { kind: "final", answer: "replay" },
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "REACT_SESSION_STALE",
    });
    expect(harness.commands).toHaveLength(0);
  });

  it("claims an action before awaiting and rejects concurrent replay", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createCatalogHarness(async () => {
      await blocked;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const created = createReActController(harness.catalog, 2);
    if (created.status !== "created") {
      throw new Error("controller setup failed");
    }
    const started = created.controller.start({
      taskId: "race",
      objectiveDigest: digestValue("race"),
    });
    if (started.status !== "started") throw new Error("start failed");
    const input = {
      session: started.session,
      turn: {
        kind: "action",
        command: { command: "verify.tests", testIds: ["focused"] },
      },
    };
    const first = created.controller.advance(input);
    await expect(created.controller.advance(input)).resolves.toEqual({
      status: "rejected",
      code: "REACT_SESSION_STALE",
    });
    release?.();
    await expect(first).resolves.toMatchObject({ status: "observed" });
    expect(harness.commands).toHaveLength(1);
  });

  it("rejects invalid budgets before creating controller state", () => {
    const harness = createCatalogHarness();
    expect(createReActController(harness.catalog, 0)).toEqual({
      status: "rejected",
      code: "INVALID_REACT_CONFIG",
    });
    expect(createReActController(harness.catalog, 65)).toEqual({
      status: "rejected",
      code: "INVALID_REACT_CONFIG",
    });
  });
});
