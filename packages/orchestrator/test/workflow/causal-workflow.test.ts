// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  createLocalRepositoryLeaseAuthority,
  type RepositoryLeaseAuthorityPort,
} from "@skizzles/workspace-transaction";
import { createCausalWorkflow } from "../../src/workflow/causal-workflow.ts";
import type { CausalWorkflow } from "../../src/workflow/contract.ts";
import { createHarness, repositoryContext } from "../support.ts";
import { IsolatedDestination } from "./isolated-destination.ts";

interface FixtureOptions {
  readonly advanceBeforePromoteMs?: number;
  readonly commandScript?: string;
  readonly crashStep?: string;
  readonly failLeaseReleaseAfterCommit?: boolean;
  readonly legacyCwd?: readonly string[];
  readonly commandArgv?: readonly string[];
  readonly dependencyPackages?: readonly string[];
  readonly workspaceUsageLimits?: Readonly<{
    byteLimit: number;
    entryLimit: number;
    scanLimit: number;
  }>;
  readonly stderr?: "evidence" | "must-be-empty";
}

function createFixture(options: FixtureOptions = {}): {
  readonly workflow: CausalWorkflow;
  readonly destination: IsolatedDestination;
  readonly orchestrator: ReturnType<typeof createHarness>["orchestrator"];
} {
  let advanceClock = (): void => undefined;
  let revalidationCount = 0;
  const harness = createHarness({
    targetRevalidate(input) {
      revalidationCount += 1;
      if (
        revalidationCount === 1 &&
        options.advanceBeforePromoteMs !== undefined
      ) {
        advanceClock();
      }
      return {
        reservationId: input.reservationId,
        repositoryId: input.repositoryId,
        requestDigest: input.requestDigest,
        treeDigest: input.treeDigest,
        targets: input.targets,
        headDigest: input.headDigest,
        indexDigest: input.indexDigest,
        worktreeDigest: input.worktreeDigest,
        statusDigest: input.statusDigest,
        unchanged: true,
      };
    },
  });
  const { orchestrator } = harness;
  advanceClock = () =>
    harness.clock.advance(options.advanceBeforePromoteMs ?? 0);
  const destination = new IsolatedDestination();
  const localLeases = createLocalRepositoryLeaseAuthority([
    { repositoryId: "repo-a", rootIdentity: "root-a", ownerId: "worker-a" },
  ]);
  const leases: RepositoryLeaseAuthorityPort =
    options.failLeaseReleaseAfterCommit
      ? {
          async acquirePublication(input: {
            readonly repositoryId: string;
            readonly rootIdentity: string;
            readonly ownerId: string;
          }) {
            const decision = await localLeases.acquirePublication(input);
            if (decision.status !== "acquired") return decision;
            return {
              status: "acquired",
              lease: {
                ...decision.lease,
                async release(): Promise<void> {
                  await decision.lease.release();
                  throw new Error("injected post-commit lease cleanup failure");
                },
              },
            };
          },
        }
      : localLeases;
  const result = createCausalWorkflow({
    orchestrator,
    publicationIdentity: {
      repositoryId: "repo-a",
      rootIdentity: "root-a",
      ownerId: "worker-a",
    },
    baselineAuthority: {
      capture(input: {
        readonly baseline: { readonly baselineDigest: string };
        readonly targets: readonly { readonly path: string }[];
      }) {
        return {
          baselineDigest: input.baseline.baselineDigest,
          targets: input.targets.map((target) => ({
            path: target.path,
            expected: { state: "missing" },
          })),
        };
      },
    },
    transaction: {
      destination,
      leases,
      ...(options.crashStep === undefined
        ? {}
        : {
            crashInjection: {
              checkpoint(input: { readonly step: string }): boolean {
                return input.step === options.crashStep;
              },
            },
          }),
    },
    workspaceUsageLimits: options.workspaceUsageLimits ?? {
      byteLimit: 1_000_000,
      entryLimit: 200,
      scanLimit: 200,
    },
    commandProfiles: [
      {
        id: "write-candidate",
        ...(options.legacyCwd === undefined ? {} : { cwd: options.legacyCwd }),
        argv: options.commandArgv ?? [
          process.execPath,
          "-e",
          options.commandScript ??
            "if (await Bun.file('src/file.ts').text() !== 'new-content') process.exit(9)",
          "src/file.ts",
        ],
        env: {},
        dependencyPackages: options.dependencyPackages ?? [],
        timeoutMilliseconds: 5000,
        maximumOutputBytes: 10_000,
        drainMilliseconds: 1000,
        signalGraceMilliseconds: 1000,
        allowedExitCodes: [0],
        stderr: options.stderr ?? "must-be-empty",
      },
    ],
    approvalContext: {
      taskId: "task-a",
      principalId: "maintainer-a",
      operation: "publish",
    },
  });
  if (result.status !== "accepted") {
    throw new Error("valid causal workflow rejected");
  }
  return { workflow: result.workflow, destination, orchestrator };
}

async function prepare(fixture: ReturnType<typeof createFixture>) {
  const context = await repositoryContext(fixture.orchestrator);
  const result = await fixture.workflow.prepare({
    ...context,
    targets: [
      {
        path: "src/file.ts",
        operation: "write",
        candidateBytes: Array.from(new TextEncoder().encode("new-content")),
      },
    ],
    discoveryRoot: "packages/orchestrator",
    commands: ["write-candidate"],
  });
  if (result.status !== "awaiting-approval") {
    throw new Error(`workflow preparation failed: ${result.code}`);
  }
  return result.review;
}

describe("causal Phase 2 workflow", () => {
  it("compiles and tests a candidate against external and workspace dependencies inside the private scope", async () => {
    const candidatePath = "test/dependency-candidate.test.ts";
    const candidateSource = [
      'import { expect, test } from "bun:test";',
      'import { create } from "@skizzles/run-workspace";',
      'import { z } from "zod";',
      'test("staged dependency closure", () => {',
      '  expect(z.literal("validated").parse("validated")).toBe("validated");',
      '  expect(typeof create).toBe("function");',
      "});",
      "",
    ].join("\n");
    const fixture = createFixture({
      commandArgv: [process.execPath, "test", candidatePath],
      dependencyPackages: ["zod", "@skizzles/run-workspace"],
      workspaceUsageLimits: {
        byteLimit: 15_000_000,
        entryLimit: 2_000,
        scanLimit: 2_000,
      },
      stderr: "evidence",
    });
    const context = await repositoryContext(fixture.orchestrator);
    const result = await fixture.workflow.prepare({
      ...context,
      targets: [
        {
          path: candidatePath,
          operation: "write",
          candidateBytes: Array.from(new TextEncoder().encode(candidateSource)),
        },
      ],
      discoveryRoot: "packages/orchestrator",
      commands: ["write-candidate"],
    });
    if (result.status !== "awaiting-approval") {
      throw new Error(`dependency-backed workflow failed: ${result.code}`);
    }
    expect(result.review.commandAudits[0]?.declaredTargetPaths).toEqual([
      candidatePath,
    ]);
    expect(result.review.commandAudits[0]?.scope.dependencies).toEqual([
      expect.objectContaining({
        name: "@skizzles/run-workspace",
        kind: "workspace",
        direct: true,
        packageDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      }),
      expect.objectContaining({
        name: "zod",
        kind: "external",
        direct: true,
        packageDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      }),
    ]);
    expect(result.review.commandAudits[0]?.scope.dependencyDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    await expect(
      fixture.workflow.reject({ review: result.review }),
    ).resolves.toMatchObject({
      status: "rejected",
      cleanup: { complete: true, workspace: { state: "deleted" } },
    });
  }, 20_000);

  it("keeps the canonical target unchanged until single-use approval and publication", async () => {
    const fixture = createFixture();
    const review = await prepare(fixture);
    expect(fixture.destination.currentText("src/file.ts")).toBeUndefined();
    expect(review.commandAudits).toHaveLength(1);
    expect(review.commandAudits[0]?.receipt.lifecycle.drain).toBe("complete");
    expect(review.commandAudits[0]?.declaredTargetPaths).toEqual([
      "src/file.ts",
    ]);
    expect(review.commandAudits[0]?.scope).toMatchObject({
      stagedTreeDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      candidateDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      targets: [
        {
          path: "src/file.ts",
          operation: "write",
          candidateDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      ],
    });
    const result = await fixture.workflow.approveAndPromote({
      review,
      token: "approve",
    });
    expect(result.status).toBe("completed");
    expect(fixture.destination.currentText("src/file.ts")).toBe("new-content");
    if (result.status !== "completed") {
      throw new Error("approved workflow did not complete");
    }
    expect(result.cleanup).toMatchObject({
      complete: true,
      targetReleased: true,
      workspace: { state: "deleted" },
    });
    await expect(
      fixture.workflow.approveAndPromote({ review, token: "approve" }),
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("cleans its exact workspace and releases the target on rejection", async () => {
    const fixture = createFixture();
    const review = await prepare(fixture);
    const result = await fixture.workflow.reject({ review });
    expect(result).toMatchObject({
      status: "rejected",
      code: "APPROVAL_REJECTED",
      cleanup: {
        complete: true,
        targetReleased: true,
        workspace: { state: "deleted" },
      },
    });
    expect(fixture.destination.currentText("src/file.ts")).toBeUndefined();
  });

  it("fails closed and cleans up when a registered command exits unsuccessfully", async () => {
    const fixture = createFixture({ commandScript: "process.exit(7)" });
    const context = await repositoryContext(fixture.orchestrator);
    const result = await fixture.workflow.prepare({
      ...context,
      targets: [
        {
          path: "src/file.ts",
          operation: "write",
          candidateBytes: Array.from(new TextEncoder().encode("new-content")),
        },
      ],
      discoveryRoot: "packages/orchestrator",
      commands: ["write-candidate"],
    });
    expect(result).toMatchObject({
      status: "rejected",
      code: "COMMAND_OBSERVATION_REJECTED",
      cleanup: {
        complete: true,
        targetReleased: true,
        workspace: { state: "deleted" },
      },
    });
    expect(fixture.destination.currentText("src/file.ts")).toBeUndefined();
  });

  it("releases execution dedupe after failure until the retained budget is exhausted", async () => {
    const fixture = createFixture({ commandScript: "process.exit(7)" });
    const context = await repositoryContext(fixture.orchestrator);
    const input = {
      ...context,
      targets: [
        {
          path: "src/file.ts",
          operation: "write",
          candidateBytes: Array.from(new TextEncoder().encode("new-content")),
        },
      ],
      discoveryRoot: "packages/orchestrator",
      commands: ["write-candidate"],
    };
    await expect(fixture.workflow.prepare(input)).resolves.toMatchObject({
      status: "rejected",
      code: "COMMAND_OBSERVATION_REJECTED",
    });
    await expect(fixture.workflow.prepare(input)).resolves.toMatchObject({
      status: "rejected",
      code: "COMMAND_OBSERVATION_REJECTED",
    });
    await expect(fixture.workflow.prepare(input)).resolves.toMatchObject({
      status: "rejected",
      code: "EXECUTION_BUDGET_REJECTED",
    });
  });

  it("never follows a command-created candidate symlink outside its owned cwd", async () => {
    const outside = await mkdtemp(join(tmpdir(), "skizzles-containment-"));
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "outside-safe", { mode: 0o600 });
    const script = [
      "const fs = await import('node:fs/promises')",
      "await fs.unlink('src/file.ts')",
      `await fs.symlink(${JSON.stringify(sentinel)}, 'src/file.ts')`,
    ].join(";");
    const fixture = createFixture({ commandScript: script });
    const context = await repositoryContext(fixture.orchestrator);
    const result = await fixture.workflow.prepare({
      ...context,
      targets: [
        {
          path: "src/file.ts",
          operation: "write",
          candidateBytes: Array.from(new TextEncoder().encode("new-content")),
        },
      ],
      discoveryRoot: "packages/orchestrator",
      commands: ["write-candidate"],
    });
    expect(result).toMatchObject({
      status: "rejected",
      code: "COMMAND_OBSERVATION_REJECTED",
      cleanup: { complete: true, workspace: { state: "deleted" } },
    });
    expect(await readFile(sentinel, "utf8")).toBe("outside-safe");
    expect(fixture.destination.currentText("src/file.ts")).toBeUndefined();
  });

  it("rejects caller-selected command and candidate paths before filesystem use", async () => {
    const outside = await mkdtemp(join(tmpdir(), "skizzles-path-input-"));
    expect(() => createFixture({ legacyCwd: [outside] })).toThrow(
      "valid causal workflow rejected",
    );
    const fixture = createFixture();
    const context = await repositoryContext(fixture.orchestrator);
    const result = await fixture.workflow.prepare({
      ...context,
      targets: [
        {
          path: "src/file.ts",
          operation: "write",
          workspacePath: [outside, "sentinel.txt"],
        },
      ],
      discoveryRoot: "packages/orchestrator",
      commands: ["write-candidate"],
    });
    expect(result).toEqual({
      status: "rejected",
      code: "INVALID_WORKFLOW_INPUT",
      cleanup: null,
    });
  });

  it("recovers a crash-injected publication through a single-use bound handle", async () => {
    const fixture = createFixture({ crashStep: "target-published" });
    const review = await prepare(fixture);
    const promotion = await fixture.workflow.approveAndPromote({
      review,
      token: "approve",
    });
    expect(promotion.status).toBe("recovery-required");
    if (promotion.status !== "recovery-required") {
      throw new Error("crash did not retain recovery authority");
    }
    expect(fixture.destination.currentText("src/file.ts")).toBe("new-content");
    const recovered = await fixture.workflow.recover({
      handle: promotion.handle,
    });
    expect(recovered).toMatchObject({
      status: "completed",
      recovery: { ok: true, status: "recovered-new" },
      cleanup: {
        complete: true,
        targetReleased: true,
        workspace: { state: "deleted" },
      },
    });
    await expect(
      fixture.workflow.recover({ handle: promotion.handle }),
    ).resolves.toEqual({ status: "rejected", code: "WORKFLOW_STALE" });
  });

  it("reports committed truth without recovery when only transaction lease cleanup fails", async () => {
    const fixture = createFixture({ failLeaseReleaseAfterCommit: true });
    const review = await prepare(fixture);
    const result = await fixture.workflow.approveAndPromote({
      review,
      token: "approve",
    });
    expect(result).toMatchObject({
      status: "publication-committed-cleanup-failed",
      code: "PUBLICATION_CLEANUP_FAILED",
      publication: {
        publicationCommitted: true,
        recoveryRequired: false,
        status: "committed-no-recovery-lease-cleanup-failed",
      },
      cleanup: { complete: true, targetReleased: true },
    });
    expect(fixture.destination.currentText("src/file.ts")).toBe("new-content");
  });

  it("allows the exact approval deadline and publishes", async () => {
    const fixture = createFixture({ advanceBeforePromoteMs: 200 });
    const review = await prepare(fixture);
    const result = await fixture.workflow.approveAndPromote({
      review,
      token: "approve",
    });
    expect(result.status).toBe("completed");
    expect(fixture.destination.currentText("src/file.ts")).toBe("new-content");
    expect(fixture.destination.captureCount).toBeGreaterThan(0);
  });

  it("rejects an approval advanced beyond expiry before publisher invocation", async () => {
    const fixture = createFixture({ advanceBeforePromoteMs: 201 });
    const review = await prepare(fixture);
    const result = await fixture.workflow.approveAndPromote({
      review,
      token: "approve",
    });
    expect(result).toMatchObject({
      status: "rejected",
      code: "APPROVAL_EXPIRED",
      cleanup: { complete: true, targetReleased: true },
    });
    expect(fixture.destination.captureCount).toBe(0);
    expect(fixture.destination.currentText("src/file.ts")).toBeUndefined();
  });
});
