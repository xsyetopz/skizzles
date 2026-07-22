// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { createAgentlessExecutor } from "../../../src/paradigms/execution/agentless.ts";
import {
  createExecutionCommandCatalog,
  isExecutionCommandCatalog,
} from "../../../src/paradigms/execution/catalog.ts";
import {
  createCodeActExecutor,
  createCodeActSandboxCapability,
  isCodeActExecutor,
  isCodeActSandboxCapability,
} from "../../../src/paradigms/execution/codeact.ts";
import { createReActController } from "../../../src/paradigms/execution/react.ts";
import { createCatalogHarness } from "./fixture.ts";

describe("schema-stable execution capabilities", () => {
  it("exposes only the fixed locate, patch, and verify catalog", async () => {
    const harness = createCatalogHarness();
    expect(isExecutionCommandCatalog(harness.catalog)).toBe(true);
    expect(harness.catalog.commands).toEqual([
      "locate.symbol",
      "locate.text",
      "patch.apply",
      "verify.tests",
    ]);
    expect(Object.isFrozen(harness.catalog.commands)).toBe(true);
    expect(harness.catalog.commands).not.toContain("shell");
    await expect(
      harness.catalog.execute({ command: "shell", source: "rm -rf /" }),
    ).resolves.toEqual({ status: "rejected", code: "INVALID_COMMAND" });
    expect(harness.commands).toHaveLength(0);
  });

  it("copies and freezes authority output instead of trusting caller metadata", async () => {
    const raw = { stdout: "located", stderr: "", exitCode: 0 };
    const harness = createCatalogHarness(() => raw);
    const result = await harness.catalog.execute({
      command: "locate.text",
      root: "packages/orchestrator",
      query: "workflow",
    });
    raw.stdout = "changed-after-return";
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.observation).toMatchObject({
      stdout: "located",
      stderr: "",
      exitCode: 0,
      stdoutBytes: 7,
      stderrBytes: 0,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observation)).toBe(true);
  });

  it("fails closed on hostile authorities, accessors, and malformed output", async () => {
    let calls = 0;
    const hostileAuthority = Object.defineProperty(
      {
        authorityId: "hostile",
        locateSymbol() {
          calls += 1;
        },
        locateText() {
          calls += 1;
        },
        applyPatch() {
          calls += 1;
        },
        verifyTests() {
          calls += 1;
        },
      },
      "authorityId",
      { enumerable: true, get: () => "forged" },
    );
    const executor = createCatalogHarness().executor;
    expect(createExecutionCommandCatalog(hostileAuthority, executor)).toEqual({
      status: "rejected",
      code: "INVALID_COMMAND_AUTHORITY",
    });
    expect(createExecutionCommandCatalog(new Proxy({}, {}), executor)).toEqual({
      status: "rejected",
      code: "INVALID_COMMAND_AUTHORITY",
    });
    const malformed = createCatalogHarness(() => ({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      forged: true,
    }));
    await expect(
      malformed.catalog.execute({
        command: "verify.tests",
        testIds: ["focused"],
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "COMMAND_AUTHORITY_FAILED",
    });
    const throwing = createCatalogHarness(() => {
      throw new Error("authority unavailable");
    });
    await expect(
      throwing.catalog.execute({
        command: "locate.symbol",
        root: "packages/orchestrator",
        symbol: "Workflow",
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "COMMAND_AUTHORITY_FAILED",
    });
    expect(calls).toBe(0);
  });

  it("runs CodeAct through the injected sandbox and returns immutable metadata", async () => {
    const captured: unknown[] = [];
    const raw = { stdout: "42\n", stderr: "", exitCode: 0 };
    const sandbox = createCodeActSandboxCapability({
      authorityId: "fixture-codeact-sandbox",
      execute(request: unknown) {
        captured.push(request);
        return raw;
      },
    });
    expect(sandbox.status).toBe("created");
    if (sandbox.status !== "created") return;
    expect(isCodeActSandboxCapability(sandbox.capability)).toBe(true);
    const created = createCodeActExecutor(sandbox.capability);
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    expect(isCodeActExecutor(created.executor)).toBe(true);
    const result = await created.executor.execute({
      executionId: "codeact-1",
      language: "typescript",
      source: "console.log(6 * 7);",
      workingDirectory: "packages/orchestrator",
      timeoutMilliseconds: 10_000,
    });
    raw.stdout = "forged";
    expect(captured).toHaveLength(1);
    expect(Object.isFrozen(captured[0])).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      executionId: "codeact-1",
      observation: { stdout: "42\n", stderr: "", exitCode: 0 },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === "completed") {
      expect(Object.isFrozen(result.observation)).toBe(true);
    }
  });

  it("rejects structural lookalikes and invalid sandbox responses", async () => {
    const fakeCatalog = {
      schema: "skizzles.orchestrator/execution-command-catalog/v1",
      authorityId: "fake",
      commands: ["locate.symbol", "locate.text", "patch.apply", "verify.tests"],
      execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
    expect(createAgentlessExecutor(fakeCatalog)).toEqual({
      status: "rejected",
      code: "UNTRUSTED_COMMAND_CATALOG",
    });
    expect(createReActController(fakeCatalog, 4)).toEqual({
      status: "rejected",
      code: "UNTRUSTED_COMMAND_CATALOG",
    });
    expect(
      createCodeActExecutor({
        schema: "skizzles.orchestrator/codeact-sandbox-capability/v1",
        authorityId: "fake",
      }),
    ).toEqual({ status: "rejected", code: "UNTRUSTED_SANDBOX" });

    const sandbox = createCodeActSandboxCapability({
      authorityId: "malformed-sandbox",
      execute: async () => ({ stdout: "ok", stderr: "", exitCode: -1 }),
    });
    if (sandbox.status !== "created") throw new Error("sandbox setup failed");
    const executor = createCodeActExecutor(sandbox.capability);
    if (executor.status !== "created") throw new Error("executor setup failed");
    await expect(
      executor.executor.execute({
        executionId: "codeact-2",
        language: "typescript",
        source: "export {};",
        workingDirectory: "packages/orchestrator",
        timeoutMilliseconds: 10_000,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "INVALID_SANDBOX_OUTPUT",
    });
  });
});
