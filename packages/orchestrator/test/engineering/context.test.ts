import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { ContextBindings } from "../../src/engineering/session/context.ts";
import { reserveContext } from "../../src/engineering/session/context.ts";

const digest = `sha256:${"a".repeat(64)}` as const;
const bindings: ContextBindings = Object.freeze({
  requestDigest: digest,
  repositoryId: "repo-a",
  treeDigest: digest,
  baselineDigest: digest,
  provenanceDigest: digest,
  candidateDigest: digest,
  cursorDigest: digest,
});

describe("host-owned context budget", () => {
  it("reserves an exact bound operation without caller limit fields", async () => {
    let observed: unknown;
    const result = await reserveContext(
      {
        reserve(input) {
          observed = input;
          return {
            status: "reserved",
            epoch: "epoch-a",
            reservationId: "reservation-a",
            requestDigest: requestDigest(input),
            usedUnits: 10,
            limitUnits: 100,
            completionReserveUnits: 20,
            requiredUnits: 30,
          };
        },
      },
      {
        operation: "source-advance",
        ordinal: 1,
        expectedEpoch: "epoch-a",
        bindings,
      },
    );
    expect(result.status).toBe("reserved");
    expect(observed).toEqual({
      version: 1,
      operation: "source-advance",
      ordinal: 1,
      expectedEpoch: "epoch-a",
      bindings,
    });
    expect(observed).not.toHaveProperty("limit");
    expect(observed).not.toHaveProperty("units");
  });

  it("returns a typed pause and rejects a changed authority epoch", async () => {
    const paused = await reserveContext(
      {
        reserve(input) {
          return {
            status: "paused",
            epoch: "epoch-a",
            requestDigest: requestDigest(input),
            usedUnits: 80,
            limitUnits: 100,
            completionReserveUnits: 20,
            requiredUnits: 30,
          };
        },
      },
      {
        operation: "source-start",
        ordinal: 0,
        expectedEpoch: null,
        bindings,
      },
    );
    expect(paused.status).toBe("paused");
    const drifted = await reserveContext(
      {
        reserve(input) {
          return {
            status: "reserved",
            epoch: "epoch-b",
            reservationId: "reservation-b",
            requestDigest: requestDigest(input),
            usedUnits: 10,
            limitUnits: 100,
            completionReserveUnits: 20,
            requiredUnits: 30,
          };
        },
      },
      {
        operation: "source-advance",
        ordinal: 1,
        expectedEpoch: "epoch-a",
        bindings,
      },
    );
    expect(drifted).toEqual({
      status: "rejected",
      code: "CONTEXT_BUDGET_DRIFTED",
    });
  });

  it("fails closed on malformed authority evidence and exceptions", async () => {
    await expect(
      reserveContext(
        {
          reserve() {
            return { status: "reserved", epoch: "epoch-a" };
          },
        },
        {
          operation: "phase2-prepare",
          ordinal: 3,
          expectedEpoch: "epoch-a",
          bindings,
        },
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "CONTEXT_BUDGET_REJECTED",
    });
    await expect(
      reserveContext(
        {
          reserve() {
            throw new Error("authority failed");
          },
        },
        {
          operation: "phase2-prepare",
          ordinal: 3,
          expectedEpoch: "epoch-a",
          bindings,
        },
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "CONTEXT_BUDGET_REJECTED",
    });
  });
});

describe("context budget arithmetic", () => {
  it("accepts the exact reserve boundary and rejects false status claims", async () => {
    const exact = await decision({
      status: "reserved",
      usedUnits: 50,
      limitUnits: 100,
      completionReserveUnits: 20,
      requiredUnits: 30,
    });
    expect(exact.status).toBe("reserved");
    const falseReserve = await decision({
      status: "reserved",
      usedUnits: 51,
      limitUnits: 100,
      completionReserveUnits: 20,
      requiredUnits: 30,
    });
    expect(falseReserve).toEqual({
      status: "rejected",
      code: "CONTEXT_BUDGET_REJECTED",
    });
    const falsePause = await decision({
      status: "paused",
      usedUnits: 50,
      limitUnits: 100,
      completionReserveUnits: 20,
      requiredUnits: 30,
    });
    expect(falsePause).toEqual({
      status: "rejected",
      code: "CONTEXT_BUDGET_REJECTED",
    });
  });

  it("treats safe-integer addition overflow as over budget", async () => {
    const result = await decision({
      status: "paused",
      usedUnits: Number.MAX_SAFE_INTEGER,
      limitUnits: Number.MAX_SAFE_INTEGER,
      completionReserveUnits: 0,
      requiredUnits: 1,
    });
    expect(result.status).toBe("paused");
  });
});

async function decision(input: {
  readonly status: "reserved" | "paused";
  readonly usedUnits: number;
  readonly limitUnits: number;
  readonly completionReserveUnits: number;
  readonly requiredUnits: number;
}) {
  return await reserveContext(
    {
      reserve(request): Readonly<Record<string, unknown>> {
        return {
          status: input.status,
          epoch: "epoch-a",
          ...(input.status === "reserved"
            ? { reservationId: "reservation-a" }
            : {}),
          requestDigest: requestDigest(request),
          usedUnits: input.usedUnits,
          limitUnits: input.limitUnits,
          completionReserveUnits: input.completionReserveUnits,
          requiredUnits: input.requiredUnits,
        };
      },
    },
    {
      operation: "source-advance",
      ordinal: 1,
      expectedEpoch: "epoch-a",
      bindings,
    },
  );
}

function requestDigest(input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")}`;
}
