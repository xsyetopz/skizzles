// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { recoverDiagnosticBytes } from "../src/index.ts";
import { createHarness } from "./support.ts";

describe("diagnostic trust boundary", () => {
  it("preserves raw compiler bytes and brands the parsed diagnostic", async () => {
    const { orchestrator } = createHarness();
    const bytes = new TextEncoder().encode(
      "src/main.ts(4,2): error TS2322: incompatible type\n",
    );
    const result = await orchestrator.createDiagnostic({
      code: "COMPILER_FAILED",
      severity: "error",
      summary: "TypeScript compilation failed.",
      evidence: [{ source: "tsc.stderr", bytes }],
    });
    if (result.status === "rejected") {
      throw new Error("fixture rejected");
    }
    bytes.fill(0);
    expect(recoverDiagnosticBytes(result.diagnostic.evidence[0])).toEqual(
      new TextEncoder().encode(
        "src/main.ts(4,2): error TS2322: incompatible type\n",
      ),
    );
    expect(Object.isFrozen(result.diagnostic.evidence[0]?.bytes)).toBe(true);
  });

  it("rejects unknown severity, invalid code, abuse, and malformed input", async () => {
    const { orchestrator } = createHarness();
    for (const input of [
      {
        code: "COMPILER_FAILED",
        severity: "fatal",
        summary: "Compilation failed.",
        evidence: [],
      },
      { code: "bad", severity: "error", summary: "Failed.", evidence: [] },
      {
        code: "COMPILER_FAILED",
        severity: "error",
        summary: "You are stupid.",
        evidence: [{ source: "tsc.stderr", bytes: [1] }],
      },
      {
        code: "COMPILER_FAILED",
        severity: "error",
        summary: "You are a worthless piece of trash.",
        evidence: [{ source: "tsc.stderr", bytes: [1] }],
      },
      {
        code: "COMPILER_FAILED",
        severity: "error",
        summary: "I think compilation failed.",
        evidence: [{ source: "tsc.stderr", bytes: [1] }],
      },
      {
        code: "COMPILER_FAILED",
        severity: "error",
        summary: "We found a compiler failure.",
        evidence: [{ source: "tsc.stderr", bytes: [1] }],
      },
      {
        code: "COMPILER_FAILED",
        severity: "error",
        summary: "I'm seeing a compiler failure.",
        evidence: [{ source: "tsc.stderr", bytes: [1] }],
      },
      {
        code: "COMPILER_FAILED",
        severity: "error",
        summary: "I’ve found a compiler failure.",
        evidence: [{ source: "tsc.stderr", bytes: [1] }],
      },
      {
        code: "COMPILER_FAILED",
        severity: "error",
        summary: "We're seeing a compiler failure.",
        evidence: [{ source: "tsc.stderr", bytes: [1] }],
      },
      {
        code: "COMPILER_FAILED",
        severity: "error",
        summary: "TypeScript compilation failed.",
        evidence: [],
      },
      null,
    ]) {
      await expect(orchestrator.createDiagnostic(input)).resolves.toEqual({
        status: "rejected",
        code: "INVALID_DIAGNOSTIC",
      });
    }
  });

  it("does not confuse technical I tokens or embedded text with first person", async () => {
    const { orchestrator } = createHarness();
    for (const summary of [
      "I/O compilation failed.",
      "Editing pipeline compilation failed.",
      "Identifier IValue failed compilation.",
    ]) {
      await expect(
        orchestrator.createDiagnostic({
          code: "COMPILER_FAILED",
          severity: "error",
          summary,
          evidence: [{ source: "tsc.stderr", bytes: [1] }],
        }),
      ).resolves.toMatchObject({ status: "accepted" });
    }
  });

  it("rejects forged diagnostics at composition", async () => {
    const { orchestrator } = createHarness();
    expect(
      await orchestrator.composeOutput({
        artifacts: [],
        presentation: [],
        diagnostics: [
          {
            code: "FORGED_DIAGNOSTIC",
            severity: "error",
            summary: "Forged.",
            evidence: [],
            digest: `sha256:${"0".repeat(64)}`,
          },
        ],
      }),
    ).toEqual({ status: "rejected", code: "INVALID_DIAGNOSTIC" });
  });

  it("prevents interceptors from weakening diagnostic invariants", async () => {
    const { orchestrator } = createHarness({
      interceptor: {
        intercept(diagnostic) {
          return {
            code: diagnostic.code,
            severity: "info",
            summary: "Compilation produced information.",
            evidence: diagnostic.evidence.map((item) => ({
              source: item.source,
              bytes: item.bytes,
            })),
          };
        },
      },
    });
    expect(
      await orchestrator.createDiagnostic({
        code: "COMPILER_FAILED",
        severity: "error",
        summary: "TypeScript compilation failed.",
        evidence: [{ source: "tsc.stderr", bytes: [1, 2, 3] }],
      }),
    ).toEqual({ status: "rejected", code: "INVALID_DIAGNOSTIC" });
  });

  it("preserves diagnostic code and exact evidence through interception", async () => {
    const interceptors = [
      {
        intercept(diagnostic: {
          readonly severity: string;
          readonly summary: string;
          readonly evidence: readonly {
            readonly source: string;
            readonly bytes: readonly number[];
          }[];
        }) {
          return {
            code: "LINTER_FAILED",
            severity: diagnostic.severity,
            summary: diagnostic.summary,
            evidence: diagnostic.evidence.map((item) => ({
              source: item.source,
              bytes: item.bytes,
            })),
          };
        },
      },
      {
        intercept(diagnostic: {
          readonly code: string;
          readonly severity: string;
          readonly summary: string;
          readonly evidence: readonly { readonly source: string }[];
        }) {
          return {
            code: diagnostic.code,
            severity: diagnostic.severity,
            summary: diagnostic.summary,
            evidence: diagnostic.evidence.map((item) => ({
              source: item.source,
              bytes: [9],
            })),
          };
        },
      },
    ];
    for (const interceptor of interceptors) {
      const { orchestrator } = createHarness({ interceptor });
      expect(
        await orchestrator.createDiagnostic({
          code: "COMPILER_FAILED",
          severity: "error",
          summary: "TypeScript compilation failed.",
          evidence: [{ source: "tsc.stderr", bytes: [1, 2, 3] }],
        }),
      ).toEqual({ status: "rejected", code: "INVALID_DIAGNOSTIC" });
    }
  });

  it("contains hostile diagnostic evidence getters", () => {
    const hostile = Object.defineProperty({}, "source", {
      get() {
        throw new Error("hostile source getter");
      },
    });
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile evidence proxy");
        },
      },
    );
    expect(() => recoverDiagnosticBytes(hostile)).not.toThrow();
    expect(recoverDiagnosticBytes(hostile)).toBeUndefined();
    expect(() => recoverDiagnosticBytes(proxy)).not.toThrow();
    expect(recoverDiagnosticBytes(proxy)).toBeUndefined();
  });
});
