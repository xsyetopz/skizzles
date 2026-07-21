// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { createHarness, requestBytes } from "./support.ts";

const encoder = new TextEncoder();

describe("registered artifact and presentation boundary", () => {
  it("rejects unknown kinds and forged artifact-shaped values", async () => {
    const { orchestrator } = createHarness();
    expect(
      await orchestrator.composeOutput({
        artifacts: [{ kind: "executable", bytes: [1] }],
        presentation: [],
        diagnostics: [],
      }),
    ).toEqual({ status: "rejected", code: "UNKNOWN_ARTIFACT_KIND" });
    expect(
      await orchestrator.composeOutput({
        artifacts: [
          { kind: "code", bytes: [1], digest: `sha256:${"0".repeat(64)}` },
        ],
        presentation: [],
        diagnostics: [],
      }),
    ).toEqual({ status: "rejected", code: "INVALID_OUTPUT" });
  });

  it("does not trust an artifact branded by a different validator registry", async () => {
    const first = createHarness().orchestrator;
    const second = createHarness().orchestrator;
    const composed = await first.composeOutput({
      artifacts: [
        {
          kind: "code",
          bytes: Array.from(encoder.encode("export const local = true;\n")),
        },
      ],
      presentation: [],
      diagnostics: [],
    });
    if (composed.status === "rejected") throw new Error("fixture rejected");
    expect(second.createFilePayload(composed.output.artifacts[0])).toEqual({
      status: "rejected",
      code: "UNVERIFIED_ARTIFACT",
    });
  });

  it("snapshots mutable bytes and emits immutable file payloads", async () => {
    const bytes = encoder.encode("export const answer = 42;\n");
    const { orchestrator } = createHarness();
    const output = await orchestrator.composeOutput({
      artifacts: [{ kind: "code", bytes }],
      presentation: [],
      diagnostics: [],
    });
    if (output.status === "rejected") {
      throw new Error("fixture rejected");
    }
    const artifact = output.output.artifacts[0];
    if (artifact === undefined) {
      throw new Error("artifact missing");
    }
    bytes.fill(0);
    expect(artifact.bytes[0]).not.toBe(0);
    const payload = orchestrator.createFilePayload(artifact);
    expect(payload.status).toBe("accepted");
    if (payload.status === "accepted") {
      expect(Object.isFrozen(payload.bytes)).toBe(true);
      expect(() => Reflect.set(payload.bytes, "0", 0)).not.toThrow();
      expect(payload.bytes[0]).toBe(101);
    }
  });

  it("accounts for a 200-word presentation internally", async () => {
    const { orchestrator } = createHarness({ tokenCap: 1000, byteCap: 10_000 });
    const text = Array.from({ length: 200 }, () => "word").join(" ");
    const result = await orchestrator.composeOutput({
      artifacts: [],
      presentation: [text],
      diagnostics: [],
    });
    if (result.status === "rejected") {
      throw new Error("fixture rejected");
    }
    expect(
      result.output.presentation[0]?.estimatedTokens,
    ).toBeGreaterThanOrEqual(200);
    expect(
      await orchestrator.composeOutput({
        artifacts: [],
        presentation: [{ text, tokenCount: 0 }],
        diagnostics: [],
      }),
    ).toEqual({ status: "rejected", code: "INVALID_OUTPUT" });
  });

  it("bounds the actual wrapper output after spawn", async () => {
    const { orchestrator } = createHarness({
      tokenCap: 4,
      byteCap: 20,
      spawnOutput: {
        artifacts: [
          {
            kind: "code",
            bytes: Array.from(encoder.encode("export const safe = true;\n")),
          },
        ],
        presentation: ["kept", "this presentation is far too long"],
        diagnostics: [],
      },
    });
    const result = await orchestrator.run({
      rawRequest: requestBytes(),
      repository: { id: "repo-a" },
    });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output.artifacts).toHaveLength(1);
      expect(result.output.presentation.map((item) => item.text)).toEqual([
        "kept",
      ]);
      expect(result.output.omittedPresentation).toBe(1);
    }
  });

  it("accepts a neutral registered diagnostic interceptor", async () => {
    let intercepts = 0;
    const { orchestrator } = createHarness({
      interceptor: {
        intercept(diagnostic) {
          intercepts += 1;
          return diagnostic;
        },
      },
    });
    const result = await orchestrator.composeOutput({
      artifacts: [],
      presentation: [],
      diagnostics: [
        {
          code: "COMPILER_FAILED",
          severity: "error",
          summary: "TypeScript compilation failed.",
          evidence: [{ source: "tsc.stderr", bytes: [1, 2, 3] }],
        },
      ],
    });
    expect(result.status).toBe("accepted");
    expect(intercepts).toBe(1);
  });
});
