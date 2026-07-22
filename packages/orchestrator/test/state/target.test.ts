import { describe, expect, it } from "bun:test";
import { createHarness, repositoryContext } from "../facade/support.ts";

function captureResult(
  input: Readonly<Record<string, unknown>>,
  state = "clean",
): Readonly<Record<string, unknown>> {
  const targets = input["targets"];
  if (!Array.isArray(targets)) throw new Error("fixture targets missing");
  return {
    reservationId: input["reservationId"],
    repositoryId: input["repositoryId"],
    requestDigest: input["requestDigest"],
    treeDigest: input["treeDigest"],
    targets,
    headBytes: [1],
    indexBytes: [2],
    worktreeBytes: [3],
    statusBytes: [4],
    statuses: targets.map((path) => ({ path, state })),
  };
}

describe("target baseline authority", () => {
  it("reserves normalized overlapping targets before authority capture", async () => {
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let authorityInput: Readonly<Record<string, unknown>> | undefined;
    const { orchestrator, counts } = createHarness({
      targetCapture(input) {
        authorityInput = input;
        return pending;
      },
    });
    const context = await repositoryContext(orchestrator);
    const first = orchestrator.captureTargetBaseline({
      ...context,
      targets: ["packages/orchestrator/src"],
    });
    await Promise.resolve();
    await expect(
      orchestrator.captureTargetBaseline({
        ...context,
        targets: ["packages/orchestrator/src/runtime.ts"],
      }),
    ).resolves.toEqual({ status: "rejected", code: "TARGET_RESERVED" });
    expect(counts.targetCapture).toBe(1);
    if (release === undefined || authorityInput === undefined) {
      throw new Error("authority was not invoked");
    }
    release(captureResult(authorityInput));
    await expect(first).resolves.toMatchObject({ status: "accepted" });
  });

  it("allows unrelated dirt while rejecting every dirty declared-target state", async () => {
    const unrelated = createHarness({
      targetCapture(input) {
        return {
          ...captureResult(input),
          statusBytes: Array.from(new TextEncoder().encode("?? unrelated.txt")),
        };
      },
    });
    const context = await repositoryContext(unrelated.orchestrator);
    await expect(
      unrelated.orchestrator.captureTargetBaseline({
        ...context,
        targets: ["packages/orchestrator/src/runtime.ts"],
      }),
    ).resolves.toMatchObject({ status: "accepted" });

    for (const state of [
      "staged",
      "unstaged",
      "untracked",
      "deleted",
      "renamed",
      "conflicted",
    ]) {
      const harness = createHarness({
        targetCapture(input) {
          const result = captureResult(input, state);
          if (state !== "renamed") return result;
          const statuses = result["statuses"];
          if (!Array.isArray(statuses)) {
            throw new Error("fixture statuses missing");
          }
          return {
            ...result,
            statuses: statuses.map((entry) => {
              if (typeof entry !== "object" || entry === null) {
                throw new Error("fixture status invalid");
              }
              return {
                ...entry,
                renamedFrom: "packages/orchestrator/src/old.ts",
              };
            }),
          };
        },
      });
      const dirtyContext = await repositoryContext(harness.orchestrator);
      await expect(
        harness.orchestrator.captureTargetBaseline({
          ...dirtyContext,
          targets: ["packages/orchestrator/src/runtime.ts"],
        }),
      ).resolves.toEqual({ status: "rejected", code: "TARGET_DIRTY" });
    }
  });

  it("releases failed reservations and requires exact revalidation before promotion", async () => {
    let attempts = 0;
    const { orchestrator } = createHarness({
      targetCapture(input) {
        attempts += 1;
        return attempts === 1 ? { forged: true } : captureResult(input);
      },
      targetRevalidate(input) {
        return {
          reservationId: input.reservationId,
          repositoryId: input.repositoryId,
          requestDigest: input.requestDigest,
          treeDigest: input.treeDigest,
          targets: input.targets,
          headDigest: input.headDigest,
          indexDigest: input.indexDigest,
          worktreeDigest: input.worktreeDigest,
          statusDigest: `sha256:${"0".repeat(64)}`,
          unchanged: true,
        };
      },
    });
    const context = await repositoryContext(orchestrator);
    const input = {
      ...context,
      targets: ["packages/orchestrator/src/runtime.ts"],
    };
    await expect(orchestrator.captureTargetBaseline(input)).resolves.toEqual({
      status: "rejected",
      code: "TARGET_AUTHORITY_REJECTED",
    });
    const second = await orchestrator.captureTargetBaseline(input);
    if (second.status !== "accepted") throw new Error("retry should succeed");
    await expect(
      orchestrator.revalidateTargetBaseline(second.baseline),
    ).resolves.toEqual({ status: "rejected", code: "TARGET_DRIFTED" });
    expect(orchestrator.releaseTargetBaseline(second.baseline)).toEqual({
      status: "released",
    });
    await expect(
      orchestrator.revalidateTargetBaseline(second.baseline),
    ).resolves.toEqual({
      status: "rejected",
      code: "TARGET_BASELINE_RELEASED",
    });
  });

  it("rejects duplicate, absolute, traversal, and hostile runtime targets", async () => {
    const { orchestrator } = createHarness();
    const context = await repositoryContext(orchestrator);
    for (const targets of [
      ["/tmp/out"],
      ["packages/../outside"],
      ["packages/orchestrator", "packages/orchestrator"],
      ["packages\\orchestrator"],
    ]) {
      await expect(
        orchestrator.captureTargetBaseline({ ...context, targets }),
      ).resolves.toEqual({ status: "rejected", code: "INVALID_TARGET_INPUT" });
    }
    await expect(
      orchestrator.captureTargetBaseline(
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("hostile");
            },
          },
        ),
      ),
    ).resolves.toMatchObject({ status: "rejected" });
  });
});
