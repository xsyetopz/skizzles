import { afterEach, describe, expect, it } from "bun:test";
import { digestText } from "../../src/digest.ts";
import { advanceBatch, startBatch } from "../../src/engine/advance.ts";
import {
  batchRequest,
  cleanupAdvanceFixtures,
  createAdvanceFixture,
  driftCompilerConfig,
  replacementText,
} from "./advance-fixture.ts";

afterEach(cleanupAdvanceFixtures);

describe("source engineering batch advancement", () => {
  it("authenticates context, advances edit and format, then exposes validation", async () => {
    const fixture = await createAdvanceFixture();
    const request = batchRequest(fixture.context.receipt, fixture.nodeDigest);
    const started = startBatch(fixture.config, fixture.state, request);
    expect(started.status).toBe("ready");
    if (started.status !== "ready") throw new Error(started.code);
    expect(started.next).toEqual({ kind: "edit", ordinal: 0, epoch: 1 });

    const edited = await advanceBatch(
      fixture.config,
      fixture.state,
      Object.freeze({ cursor: started.cursor }),
    );
    expect(edited.status).toBe("ready");
    if (edited.status !== "ready") throw new Error("edit did not advance");
    expect(edited.next).toEqual({ kind: "format", ordinal: 1, epoch: 2 });
    expect(fixture.templateCalls).toBe(1);
    await expect(
      advanceBatch(
        fixture.config,
        fixture.state,
        Object.freeze({ cursor: started.cursor }),
      ),
    ).resolves.toEqual({ status: "rejected", code: "CURSOR_REPLAYED" });

    const formatted = await advanceBatch(
      fixture.config,
      fixture.state,
      Object.freeze({ cursor: edited.cursor }),
    );
    expect(formatted.status).toBe("ready");
    if (formatted.status !== "ready") throw new Error("format did not advance");
    expect(formatted.next).toEqual({ kind: "validate", ordinal: 2 });
    expect(fixture.formattedInputs).toEqual([
      `${replacementText}\n`,
      `${replacementText}\n`,
    ]);
    expect(startBatch(fixture.config, fixture.state, request)).toEqual({
      status: "rejected",
      code: "CONTEXT_REPLAYED",
    });
  });

  it("burns authentic cursors when selector drift rejects an edit", async () => {
    const fixture = await createAdvanceFixture();
    const request = batchRequest(
      fixture.context.receipt,
      digestText("forged-node"),
    );
    const started = startBatch(fixture.config, fixture.state, request);
    if (started.status !== "ready") throw new Error(started.code);
    const input = Object.freeze({ cursor: started.cursor });
    await expect(
      advanceBatch(fixture.config, fixture.state, input),
    ).resolves.toEqual({ status: "rejected", code: "EDIT_REJECTED" });
    await expect(
      advanceBatch(fixture.config, fixture.state, input),
    ).resolves.toEqual({ status: "rejected", code: "CURSOR_REPLAYED" });
  });

  it("rejects missing, gapped, reordered, and duplicate epoch plans", async () => {
    for (const operations of [
      Object.freeze([
        Object.freeze({
          kind: "delete",
          selector: Object.freeze({
            declarationKind: "function",
            name: "value",
            expectedNodeDigest: digestText("node"),
          }),
        }),
      ]),
      Object.freeze([epochDelete(2, "value")]),
      Object.freeze([epochDelete(2, "first"), epochDelete(1, "second")]),
      Object.freeze([epochDelete(1, "value"), epochDelete(2, "value")]),
    ]) {
      const fixture = await createAdvanceFixture();
      const request = batchRequest(fixture.context.receipt, fixture.nodeDigest);
      const target = request.targets[0];
      if (target === undefined) throw new Error("target missing");
      const hostile = Object.freeze({
        ...request,
        targets: Object.freeze([Object.freeze({ ...target, operations })]),
      });
      expect(startBatch(fixture.config, fixture.state, hostile)).toEqual({
        status: "rejected",
        code: "INVALID_INPUT",
      });
    }
  });

  it("fails an invalid intermediate epoch before formatting", async () => {
    const fixture = await createAdvanceFixture();
    const request = batchRequest(fixture.context.receipt, fixture.nodeDigest);
    const target = request.targets[0];
    const operation = target?.operations[0];
    if (target === undefined || operation?.kind !== "replace") {
      throw new Error("replacement fixture missing");
    }
    const invalid = Object.freeze({
      ...request,
      targets: Object.freeze([
        Object.freeze({
          ...target,
          operations: Object.freeze([
            Object.freeze({
              ...operation,
              nodeSource: "export function value(): string { return 2; }",
            }),
          ]),
        }),
      ]),
    });
    const started = startBatch(fixture.config, fixture.state, invalid);
    if (started.status !== "ready") throw new Error(started.code);
    const cursor = Object.freeze({ cursor: started.cursor });
    await expect(
      advanceBatch(fixture.config, fixture.state, cursor),
    ).resolves.toEqual({ status: "rejected", code: "COMPILER_REJECTED" });
    expect(fixture.formattedInputs).toEqual([]);
    await expect(
      advanceBatch(fixture.config, fixture.state, cursor),
    ).resolves.toEqual({ status: "rejected", code: "CURSOR_REPLAYED" });
  });

  it("rejects trusted compiler configuration drift before the format epoch commits", async () => {
    const fixture = await createAdvanceFixture();
    const started = startBatch(
      fixture.config,
      fixture.state,
      batchRequest(fixture.context.receipt, fixture.nodeDigest),
    );
    if (started.status !== "ready") throw new Error(started.code);
    const edited = await advanceBatch(
      fixture.config,
      fixture.state,
      Object.freeze({ cursor: started.cursor }),
    );
    if (edited.status !== "ready") throw new Error("edit failed");
    driftCompilerConfig();
    await expect(
      advanceBatch(
        fixture.config,
        fixture.state,
        Object.freeze({ cursor: edited.cursor }),
      ),
    ).resolves.toEqual({ status: "rejected", code: "COMPILER_REJECTED" });
  });
});

function epochDelete(epoch: number, name: string) {
  return Object.freeze({
    epoch,
    kind: "delete" as const,
    selector: Object.freeze({
      declarationKind: "function",
      name,
      expectedNodeDigest: digestText(name),
    }),
  });
}
