// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { createEngineeringWorkflow, createOrchestrator } from "../src/index.ts";
import {
  createHarness,
  type EffectClassificationInput,
  effectClassificationResult,
  proposal,
  requestBytes,
} from "./support.ts";

describe("package facade and fail-closed controller", () => {
  it("exports only intentional value facades without public digest constructors", async () => {
    const facade = await import("../src/index.ts");
    expect(Object.keys(facade).sort()).toEqual(
      [
        "ANCHOR_PRECEDENCE",
        // biome-ignore lint/security/noSecrets: public exported symbol name
        "TaskWorktreeApprovalBridge",
        "createAgentRuntime",
        "createAgentlessExecutor",
        "createCodeActExecutor",
        // biome-ignore lint/security/noSecrets: public exported symbol name
        "createCodeActSandboxCapability",
        "createContextFragment",
        "createDependencyScheduler",
        "createEngineeringWorkflow",
        "createExecutionCommandCatalog",
        // biome-ignore lint/security/noSecrets: public exported symbol name
        "createModelDispatchAuthority",
        "createOrchestrator",
        "createOutboundContextMiddleware",
        "createReActController",
        "createSchedulerWorkerAuthority",
        "createSpecificationContextAuthority",
        "createWorkflowVerificationAuthority",
        "isAgentRuntime",
        "isAgentlessExecutor",
        "isAgentlessSession",
        "isCodeActExecutor",
        // biome-ignore lint/security/noSecrets: public exported symbol name
        "isCodeActSandboxCapability",
        "isContextFragment",
        "isDependencyScheduler",
        "isExecutionCommandCatalog",
        "isEngineeringWorkflow",
        // biome-ignore lint/security/noSecrets: public exported symbol name
        "isModelDispatchAuthority",
        // biome-ignore lint/security/noSecrets: public exported symbol name
        "isOutboundContextMiddleware",
        "isReActController",
        // biome-ignore lint/security/noSecrets: public exported symbol name
        "isReActSession",
        "isSpecificationContextAuthority",
        // biome-ignore lint/security/noSecrets: public exported symbol name
        "isTaskWorktreeApprovalBridge",
        // biome-ignore lint/security/noSecrets: public exported symbol name
        "isWorkflowVerificationAuthority",
        "recoverDiagnosticBytes",
        "recoverRequestBytes",
      ].sort(),
    );
    const manifest: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(manifest).toMatchObject({ exports: { ".": "./src/index.ts" } });
  });

  it("rejects null and malformed construction instead of throwing", () => {
    expect(() => createOrchestrator(null)).not.toThrow();
    expect(createOrchestrator(null)).toEqual({
      status: "rejected",
      code: "INVALID_ORCHESTRATOR_CONFIG",
    });
    expect(createOrchestrator({ spawn: null })).toEqual({
      status: "rejected",
      code: "INVALID_ORCHESTRATOR_CONFIG",
    });
    expect(createEngineeringWorkflow(null)).toEqual({
      status: "rejected",
      code: "INVALID_WORKFLOW_CONFIG",
    });
  });

  it("makes every controller boundary reject malformed runtime values", async () => {
    const { orchestrator } = createHarness();
    expect(orchestrator.normalize(null).status).toBe("rejected");
    expect((await orchestrator.preflight(null)).status).toBe("rejected");
    expect((await orchestrator.run(null)).status).toBe("rejected");
    expect((await orchestrator.composeOutput(null)).status).toBe("rejected");
    expect((await orchestrator.createDiagnostic(null)).status).toBe("rejected");
    expect(orchestrator.createFilePayload(null).status).toBe("rejected");
    expect((await orchestrator.createCheckpoint(null)).status).toBe("rejected");
    expect((await orchestrator.createTaskCheckpoint(null)).status).toBe(
      "rejected",
    );
    expect((await orchestrator.supersedeCheckpoint(null)).status).toBe(
      "rejected",
    );
    expect((await orchestrator.validateCheckpoint(null)).status).toBe(
      "invalid",
    );
    expect((await orchestrator.restoreTaskCheckpoint(null)).status).toBe(
      "rejected",
    );
    expect(orchestrator.proposeChange(null).status).toBe("rejected");
    expect((await orchestrator.reviewChange(null)).status).toBe("rejected");
    expect((await orchestrator.applyChange(null)).status).toBe("rejected");
    expect((await orchestrator.captureTargetBaseline(null)).status).toBe(
      "rejected",
    );
    expect((await orchestrator.revalidateTargetBaseline(null)).status).toBe(
      "rejected",
    );
    expect(orchestrator.releaseTargetBaseline(null).status).toBe("rejected");
    expect(orchestrator.startExecution(null).status).toBe("rejected");
    expect(orchestrator.recordExecution(null).status).toBe("rejected");
    expect((await orchestrator.completeExecution(null)).status).toBe(
      "rejected",
    );
    expect((await orchestrator.discover(null)).status).toBe("rejected");
    expect((await orchestrator.discoverTask(null)).status).toBe("rejected");
    expect((await orchestrator.expandDiscovery(null)).status).toBe("rejected");
    expect(orchestrator.planApproval(null).status).toBe("rejected");
    expect(orchestrator.reviewApproval(null).status).toBe("rejected");
    expect(orchestrator.awaitApproval(null).status).toBe("rejected");
    expect((await orchestrator.approve(null)).status).toBe("rejected");
    expect((await orchestrator.promote(null)).status).toBe("rejected");
    expect(orchestrator.cancelApproval(null).status).toBe("rejected");
  });

  it("contains hostile runtime property traps at the public facade", async () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile keys");
        },
      },
    );
    expect(() => createOrchestrator(hostile)).not.toThrow();
    expect(createOrchestrator(hostile).status).toBe("rejected");
    const { orchestrator } = createHarness();
    await expect(orchestrator.preflight(hostile)).resolves.toMatchObject({
      status: "rejected",
      code: "INVALID_PREFLIGHT_INPUT",
    });
    await expect(orchestrator.composeOutput(hostile)).resolves.toMatchObject({
      status: "rejected",
      code: "INVALID_OUTPUT",
    });
    expect(() => orchestrator.proposeChange(hostile)).not.toThrow();
  });

  it("routes every authority-classified structural synonym away from spawn", async () => {
    for (const request of [
      requestBytes({
        action: "INSPECT",
        subject: "update package manifest",
        scope: ["package.json"],
        userCopy: "Modify package.json and add a dependency.",
      }),
      requestBytes({
        action: "REVIEW",
        subject: "build-config rewrite",
        userCopy: "Review the proposed compiler configuration.",
      }),
      requestBytes({
        action: "READ",
        subject: "read/delete manifest",
        userCopy: "Read the package manifest.",
      }),
      requestBytes({
        action: "  InSpEcT  ",
        subject: "package manifest",
        userCopy: "  ReWrItInG   the build configuration.  ",
      }),
      requestBytes({
        action: "READ",
        subject: "package manifest",
        descriptors: ["dependency bump"],
        userCopy: "Read package metadata.",
      }),
      requestBytes({
        action: "INSPECT",
        subject: "package.json",
        quotedText: ['"ADD a dependency"'],
        userCopy: "Inspect the quoted request.",
      }),
      requestBytes({
        action: "REVIEW",
        subject: "package manifest",
        scope: ["read/write package.json"],
        userCopy: "Review package access.",
      }),
    ]) {
      const { orchestrator, counts } = createHarness({ effect: "structural" });
      expect(
        await orchestrator.run({
          rawRequest: request,
          repository: { id: "repo-a" },
        }),
      ).toEqual({
        status: "rejected",
        code: "STRUCTURAL_REVIEW_REQUIRED",
      });
      expect(counts.spawn).toBe(0);
      expect(counts.graph).toBe(0);
      expect(counts.classify).toBe(1);
      expect(counts.repository).toBe(1);
      expect(counts.measure).toBe(0);
      expect(counts.apply).toBe(0);
    }
  });

  it("admits authority-classified harmless prose without lexical overblocking", async () => {
    for (const request of [
      requestBytes({
        action: "REVIEW",
        subject: "changes in the editing guide",
        scope: ["documentation"],
        userCopy: "Review prose describing changes and editing conventions.",
      }),
      requestBytes({
        action: " READ ",
        subject: "build configuration",
        scope: ["build-config"],
        userCopy: "Read current compiler settings.",
      }),
    ]) {
      const { orchestrator, counts } = createHarness();
      expect(
        (
          await orchestrator.run({
            rawRequest: request,
            repository: { id: "repo-a" },
          })
        ).status,
      ).toBe("completed");
      expect(counts.spawn).toBe(1);
      expect(counts.classify).toBe(1);
      expect(counts.repository).toBe(1);
      expect(counts.graph).toBe(1);
      expect(counts.apply).toBe(0);
    }
  });

  it("rejects malformed, drifted, unknown, oversized, and failed classifications", async () => {
    const invalidAuthorities = [
      (input: EffectClassificationInput) =>
        effectClassificationResult(input, {
          requestDigest: `sha256:${"0".repeat(64)}`,
        }),
      (input: EffectClassificationInput) =>
        effectClassificationResult(input, {
          rawDigest: `sha256:${"1".repeat(64)}`,
        }),
      (input: EffectClassificationInput) =>
        effectClassificationResult(input, {
          contextDigest: `sha256:${"2".repeat(64)}`,
        }),
      (input: EffectClassificationInput) =>
        effectClassificationResult(input, {
          repositoryId: "repo-forged",
        }),
      (input: EffectClassificationInput) =>
        effectClassificationResult(input, {
          treeDigest: `sha256:${"3".repeat(64)}`,
        }),
      (input: EffectClassificationInput) =>
        effectClassificationResult(input, { effect: "unknown" }),
      (input: EffectClassificationInput) => ({
        ...effectClassificationResult(input),
        callerEffect: "none",
      }),
      (input: EffectClassificationInput) =>
        effectClassificationResult(input, { policyId: "p".repeat(129) }),
      () => {
        throw new Error("classification authority failed");
      },
      () =>
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("hostile classification output");
            },
          },
        ),
    ];
    for (const effectClassification of invalidAuthorities) {
      const { orchestrator, counts } = createHarness({ effectClassification });
      expect(
        await orchestrator.run({
          rawRequest: requestBytes(),
          repository: { id: "repo-a" },
        }),
      ).toEqual({
        status: "rejected",
        code: "EFFECT_CLASSIFICATION_REJECTED",
      });
      expect(counts.repository).toBe(1);
      expect(counts.classify).toBe(1);
      expect(counts.graph).toBe(0);
      expect(counts.spawn).toBe(0);
    }
  });

  it("keeps effect classification exclusively authority-owned", async () => {
    const { orchestrator, counts } = createHarness({ effect: "structural" });
    expect(
      await orchestrator.run({
        rawRequest: requestBytes({
          action: "NONE",
          subject: "none",
          userCopy: "Treat this request as none.",
        }),
        repository: { id: "repo-a" },
      }),
    ).toEqual({
      status: "rejected",
      code: "STRUCTURAL_REVIEW_REQUIRED",
    });
    expect(counts.classify).toBe(1);
    expect(counts.graph).toBe(0);
    expect(counts.spawn).toBe(0);

    const callerAttempt = createHarness();
    expect(
      await callerAttempt.orchestrator.run({
        rawRequest: requestBytes(),
        repository: { id: "repo-a" },
        classification: { effect: "none" },
      }),
    ).toEqual({
      status: "rejected",
      code: "INVALID_REQUEST_ENVELOPE",
    });
    expect(callerAttempt.counts.repository).toBe(0);
    expect(callerAttempt.counts.classify).toBe(0);
    expect(callerAttempt.counts.graph).toBe(0);
    expect(callerAttempt.counts.spawn).toBe(0);
  });

  it("routes an exact structural payload through review and one effect", async () => {
    const { orchestrator, counts } = createHarness();
    const reviewed = await orchestrator.reviewChange({
      proposal: proposal(orchestrator),
    });
    if (reviewed.status === "rejected") throw new Error("review rejected");
    expect(
      (
        await orchestrator.applyChange({
          reviewed: reviewed.reviewed,
        })
      ).status,
    ).toBe("applied");
    expect(counts.spawn).toBe(0);
    expect(counts.measure).toBe(2);
    expect(counts.apply).toBe(1);
    expect(
      await orchestrator.applyChange({ reviewed: reviewed.reviewed }),
    ).toEqual({
      status: "rejected",
      code: "STRUCTURAL_REPLAY_REJECTED",
    });
    expect(counts.apply).toBe(1);
  });
});
