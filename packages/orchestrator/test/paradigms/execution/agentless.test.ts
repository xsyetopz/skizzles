// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import {
  createAgentlessExecutor,
  isAgentlessSession,
} from "../../../src/paradigms/execution/agentless.ts";
import { agentlessTask, createCatalogHarness } from "./fixture.ts";

describe("default agentless execution", () => {
  it("enforces Locate then Patch then Verify and completes only after verification", async () => {
    const harness = createCatalogHarness((request) => ({
      stdout: request.command,
      stderr: "",
      exitCode: 0,
    }));
    const created = createAgentlessExecutor(harness.catalog);
    if (created.status !== "created") throw new Error("executor setup failed");
    const started = created.executor.start(agentlessTask());
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    expect(started.session).toMatchObject({ stage: "locate", version: 0 });
    expect(isAgentlessSession(started.session)).toBe(true);

    const located = await created.executor.advance({
      session: started.session,
    });
    expect(located).toMatchObject({
      status: "advanced",
      completedStage: "locate",
      session: { stage: "patch", version: 1 },
    });
    if (located.status !== "advanced") return;
    const patched = await created.executor.advance({
      session: located.session,
    });
    expect(patched).toMatchObject({
      status: "advanced",
      completedStage: "patch",
      session: { stage: "verify", version: 2 },
    });
    if (patched.status !== "advanced") return;
    const verified = await created.executor.advance({
      session: patched.session,
    });
    expect(verified).toMatchObject({
      status: "completed",
      completedStage: "verify",
    });
    expect(harness.commands.map((request) => request.command)).toEqual([
      "locate.symbol",
      "patch.apply",
      "verify.tests",
    ]);
  });

  it("rejects reordered plans and hostile task envelopes before execution", () => {
    const harness = createCatalogHarness();
    const created = createAgentlessExecutor(harness.catalog);
    if (created.status !== "created") throw new Error("executor setup failed");
    const task = agentlessTask();
    expect(
      created.executor.start({
        ...task,
        locate: task.patch,
        patch: task.locate,
      }),
    ).toEqual({ status: "rejected", code: "INVALID_AGENTLESS_TASK" });
    expect(
      created.executor.start(
        new Proxy(task, {
          ownKeys() {
            throw new Error("hostile proxy");
          },
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_AGENTLESS_TASK" });
    expect(harness.commands).toHaveLength(0);
  });

  it("rejects replay, structural session forgery, and cross-executor use", async () => {
    const firstHarness = createCatalogHarness();
    const secondHarness = createCatalogHarness();
    const first = createAgentlessExecutor(firstHarness.catalog);
    const second = createAgentlessExecutor(secondHarness.catalog);
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("executor setup failed");
    }
    const started = first.executor.start(agentlessTask());
    if (started.status !== "started") throw new Error("start failed");
    const advanced = await first.executor.advance({ session: started.session });
    await expect(
      first.executor.advance({ session: started.session }),
    ).resolves.toEqual({
      status: "rejected",
      code: "AGENTLESS_SESSION_STALE",
    });
    await expect(
      first.executor.advance({ session: { ...started.session, version: 1 } }),
    ).resolves.toEqual({
      status: "rejected",
      code: "INVALID_AGENTLESS_ADVANCE",
    });
    if (advanced.status !== "advanced") return;
    await expect(
      second.executor.advance({ session: advanced.session }),
    ).resolves.toEqual({
      status: "rejected",
      code: "AGENTLESS_SESSION_STALE",
    });
    expect(secondHarness.commands).toHaveLength(0);
  });

  it("claims a stage before awaiting so concurrent replay cannot double execute", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createCatalogHarness(async () => {
      await blocked;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const created = createAgentlessExecutor(harness.catalog);
    if (created.status !== "created") throw new Error("executor setup failed");
    const started = created.executor.start(agentlessTask());
    if (started.status !== "started") throw new Error("start failed");
    const first = created.executor.advance({ session: started.session });
    await expect(
      created.executor.advance({ session: started.session }),
    ).resolves.toEqual({
      status: "rejected",
      code: "AGENTLESS_SESSION_STALE",
    });
    release?.();
    await expect(first).resolves.toMatchObject({ status: "advanced" });
    expect(harness.commands).toHaveLength(1);
  });

  it("stops immediately when a stage exits unsuccessfully", async () => {
    const harness = createCatalogHarness((request) => ({
      stdout: "",
      stderr: "patch rejected",
      exitCode: request.command === "patch.apply" ? 1 : 0,
    }));
    const created = createAgentlessExecutor(harness.catalog);
    if (created.status !== "created") throw new Error("executor setup failed");
    const started = created.executor.start(agentlessTask());
    if (started.status !== "started") throw new Error("start failed");
    const located = await created.executor.advance({
      session: started.session,
    });
    if (located.status !== "advanced") throw new Error("locate failed");
    const failed = await created.executor.advance({ session: located.session });
    expect(failed).toMatchObject({
      status: "failed",
      failedStage: "patch",
      observation: { exitCode: 1, stderr: "patch rejected" },
    });
    expect(harness.commands.map((request) => request.command)).toEqual([
      "locate.symbol",
      "patch.apply",
    ]);
  });
});
