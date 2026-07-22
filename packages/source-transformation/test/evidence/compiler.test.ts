import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestText } from "../../src/digest.ts";
import {
  type CompilerCandidateOverlay,
  type CompilerEvidenceInput,
  type CompilerSymbolAuthorityPort,
  captureCompilerEvidence,
  createTypeScriptCompilerAuthority,
  isTypeScriptCompilerAuthority,
} from "../../src/evidence/compiler.ts";

const encoder = new TextEncoder();

describe("factory-issued TypeScript compiler evidence", () => {
  it("compiles exact overlay bytes against the trusted project", async () => {
    await withProject(strictConfig(), async (project) => {
      const authority = project.authority();
      const result = await captureCompilerEvidence(
        authority,
        input([
          overlay("src/value.ts", "export const value: string = 'ok';\n"),
        ]),
      );

      expect(result.status).toBe("accepted");
      if (result.status !== "accepted") {
        throw new Error("valid compilation failed");
      }
      expect(result.receipt.compiler).toMatchObject({
        passed: true,
        exitCode: 0,
      });
      expect(result.receipt.compiler.diagnostics).toEqual([]);
      expect(result.receipt).not.toHaveProperty("candidateBytes");
      expect(result.receipt.targets[0]).not.toHaveProperty("candidateBytes");
      expect(Object.isFrozen(result.receipt)).toBe(true);
    });
  });

  it("derives type diagnostics instead of accepting compiler self-report", async () => {
    await withProject(strictConfig(), async (project) => {
      const result = await captureCompilerEvidence(
        project.authority(passingSymbols()),
        input([overlay("src/value.ts", "export const value: string = 42;\n")]),
      );

      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") {
        throw new Error("invalid compilation passed");
      }
      expect(result.code).toBe("COMPILER_REJECTED");
      expect(result.diagnostics?.some(({ code }) => code === "TS2322")).toBe(
        true,
      );
    });
  });

  it("resolves imports through all candidate overlays in one batch", async () => {
    await withProject(strictConfig(), async (project) => {
      const targets = [
        overlay(
          "src/main.ts",
          "import { helper } from './helper.ts';\nimport { value } from './value.ts';\nexport const result: string = helper(value);\n",
        ),
        overlay("src/value.ts", "export const value: string = 'overlay';\n"),
      ];
      const result = await captureCompilerEvidence(
        project.authority(),
        input(targets),
      );

      expect(result.status).toBe("accepted");
      if (result.status !== "accepted") {
        throw new Error("overlay import did not resolve");
      }
      expect(result.receipt.targets.map(({ path }) => path)).toEqual([
        "src/main.ts",
        "src/value.ts",
      ]);
    });
  });

  it("rejects a real project that omits a mandatory strict option", async () => {
    await withProject(
      strictConfig({ noUncheckedIndexedAccess: false }),
      async (project) => {
        const result = await captureCompilerEvidence(
          project.authority(),
          input([overlay("src/value.ts", "export const value = 'ok';\n")]),
        );
        expect(result).toMatchObject({
          status: "rejected",
          code: "STRICT_FLAGS_REJECTED",
        });
      },
    );
  });

  it("accepts strict umbrella options with independent safety flags", async () => {
    await withProject(strictUmbrellaConfig(), async (project) => {
      const result = await captureCompilerEvidence(
        project.authority(),
        input([overlay("src/value.ts", "export const value = 'ok';\n")]),
      );
      expect(result.status).toBe("accepted");
    });
  });

  it("rejects stale candidate bytes and stale batch bindings", async () => {
    await withProject(strictConfig(), async (project) => {
      const candidate = overlay("src/value.ts", "export const value = 'ok';\n");
      const staleBytes: CompilerCandidateOverlay = Object.freeze({
        ...candidate,
        candidateBytes: Object.freeze([
          ...encoder.encode("export const value = 'changed';\n"),
        ]),
      });
      await expect(
        captureCompilerEvidence(project.authority(), input([staleBytes])),
      ).resolves.toEqual({
        status: "rejected",
        code: "STALE_CANDIDATE",
      });
      await expect(
        captureCompilerEvidence(project.authority(), {
          ...input([candidate]),
          treeDigest: digestText("other-tree"),
        }),
      ).resolves.toEqual({
        status: "rejected",
        code: "STALE_COMPILER_BINDINGS",
      });
    });
  });

  it("rejects an overlay that is not a member of the trusted project", async () => {
    await withProject(strictConfig(), async (project) => {
      const result = await captureCompilerEvidence(
        project.authority(),
        input([overlay("outside/new-file.ts", "export const hidden = 42;\n")]),
      );
      expect(result).toEqual({ status: "rejected", code: "STALE_CANDIDATE" });
    });
  });

  it("rejects structural fakes and keeps compiler truth above advisory evidence", async () => {
    await withProject(strictConfig(), async (project) => {
      const fake = Object.freeze({ kind: "typescript-7-compiler-authority" });
      expect(isTypeScriptCompilerAuthority(fake)).toBe(false);
      await expect(
        captureCompilerEvidence(
          fake,
          input([overlay("src/value.ts", "export const value = 'ok';\n")]),
        ),
      ).resolves.toEqual({
        status: "rejected",
        code: "UNAUTHENTIC_COMPILER_AUTHORITY",
      });

      const accepted = await captureCompilerEvidence(
        project.authority(failingSymbols()),
        input([overlay("src/value.ts", "export const value = 'ok';\n")]),
      );
      expect(accepted.status).toBe("accepted");
      if (accepted.status !== "accepted") {
        throw new Error("advisory evidence overruled compiler");
      }
      expect(accepted.receipt.symbolIndex).toMatchObject({
        status: "failed",
        discrepancy: true,
      });

      const rejected = await captureCompilerEvidence(
        project.authority(passingSymbols()),
        input([overlay("src/value.ts", "export const value: string = 42;\n")]),
      );
      expect(rejected).toMatchObject({
        status: "rejected",
        code: "COMPILER_REJECTED",
      });
    });
  });

  it("rejects omitted, reordered, and cross-authority spliced predecessors", async () => {
    await withProject(strictConfig(), async (project) => {
      const authority = project.authority();
      const targets = [
        overlay("src/value.ts", "export const value: string = 'ok';\n"),
      ];
      const first = await captureCompilerEvidence(authority, input(targets));
      if (first.status !== "accepted") throw new Error("first epoch failed");

      await expect(
        captureCompilerEvidence(
          authority,
          chainInput(targets, null, 2, first.receipt.candidateSetDigest),
        ),
      ).resolves.toEqual({
        status: "rejected",
        code: "COMPILER_CHAIN_REJECTED",
      });
      await expect(
        captureCompilerEvidence(
          authority,
          chainInput(
            targets,
            first.receipt,
            3,
            first.receipt.candidateSetDigest,
          ),
        ),
      ).resolves.toEqual({
        status: "rejected",
        code: "COMPILER_CHAIN_REJECTED",
      });

      const foreignAuthority = project.authority();
      const foreign = await captureCompilerEvidence(
        foreignAuthority,
        input(targets),
      );
      if (foreign.status !== "accepted") {
        throw new Error("foreign epoch failed");
      }
      await expect(
        captureCompilerEvidence(
          authority,
          chainInput(
            targets,
            foreign.receipt,
            2,
            foreign.receipt.candidateSetDigest,
          ),
        ),
      ).resolves.toEqual({
        status: "rejected",
        code: "COMPILER_CHAIN_REJECTED",
      });

      const second = await captureCompilerEvidence(
        authority,
        chainInput(targets, first.receipt, 2, first.receipt.candidateSetDigest),
      );
      expect(second.status).toBe("accepted");
      if (second.status !== "accepted") throw new Error("valid chain failed");
      expect(second.receipt.predecessorReceiptDigest).toBe(
        first.receipt.receiptDigest,
      );
    });
  });
});

interface TestProject {
  readonly authority: (symbols?: CompilerSymbolAuthorityPort) => unknown;
}

async function withProject(
  config: Readonly<Record<string, unknown>>,
  run: (project: TestProject) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "skizzles-compiler-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/value.ts"),
      "export const value = 'baseline';\n",
    );
    writeFileSync(
      join(root, "src/helper.ts"),
      "export function helper(value: string): string { return value; }\n",
    );
    writeFileSync(join(root, "src/main.ts"), "export {};\n");
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: config, include: ["src/**/*.ts"] }),
    );
    await run({
      authority(symbols?: CompilerSymbolAuthorityPort): unknown {
        const registration = createTypeScriptCompilerAuthority({
          repository: {
            repositoryId: "repo-a",
            rootIdentity: "root-a",
            treeDigest: digestText("tree"),
            configDigest: digestText("config"),
            rootPath: root,
            configPath: "tsconfig.json",
          },
          profile: {
            profileId: "strict-typescript",
            toolId: "typescript",
            toolVersion: "7.0.2",
          },
          ...(symbols === undefined ? {} : { symbols }),
        });
        if (registration.status !== "created") {
          throw new Error("compiler authority registration failed");
        }
        if (!isTypeScriptCompilerAuthority(registration.authority)) {
          throw new Error("issued compiler authority was not authentic");
        }
        return registration.authority;
      },
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function strictConfig(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    useUnknownInCatchVariables: true,
    noEmit: true,
    module: "nodenext",
    moduleResolution: "nodenext",
    target: "esnext",
    allowImportingTsExtensions: true,
    ...overrides,
  });
}

function strictUmbrellaConfig(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    module: "nodenext",
    moduleResolution: "nodenext",
    target: "esnext",
    allowImportingTsExtensions: true,
  });
}

function overlay(path: string, sourceText: string): CompilerCandidateOverlay {
  const bytes = Object.freeze([...encoder.encode(sourceText)]);
  return Object.freeze({
    path,
    candidateDigest: digestText(sourceText),
    semanticDigest: digestText(`semantic:${sourceText}`),
    candidateBytes: bytes,
  });
}

function input(
  targets: readonly CompilerCandidateOverlay[],
): CompilerEvidenceInput {
  const selected = targets[0];
  if (selected === undefined) throw new Error("test input requires a target");
  const sorted = [...targets].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return Object.freeze({
    requestDigest: digestText("request"),
    repositoryId: "repo-a",
    rootIdentity: "root-a",
    treeDigest: digestText("tree"),
    configDigest: digestText("config"),
    targetPath: selected.path,
    candidateDigest: selected.candidateDigest,
    semanticDigest: selected.semanticDigest,
    epoch: 1,
    epochKind: "edit",
    predecessorCandidateSetDigest: digestText("baseline-candidate-set"),
    candidateSetDigest: digestText(
      JSON.stringify(
        sorted.map(({ path, candidateDigest, semanticDigest }) => ({
          path,
          candidateDigest,
          semanticDigest,
        })),
      ),
    ),
    targetSetDigest: digestText(JSON.stringify(sorted.map(({ path }) => path))),
    profileId: "strict-typescript",
    toolId: "typescript",
    toolVersion: "7.0.2",
    targets: Object.freeze([...targets]),
    predecessor: null,
  });
}

function chainInput(
  targets: readonly CompilerCandidateOverlay[],
  predecessor:
    | import("../../src/evidence/compiler.ts").CompilerEvidenceReceipt
    | null,
  epoch: number,
  predecessorCandidateSetDigest: string,
): CompilerEvidenceInput {
  const first = input(targets);
  return Object.freeze({
    ...first,
    epoch,
    epochKind: "format",
    predecessorCandidateSetDigest:
      predecessorCandidateSetDigest as `sha256:${string}`,
    predecessor,
  });
}

function passingSymbols(): CompilerSymbolAuthorityPort {
  return Object.freeze({
    inspect: () =>
      Object.freeze({
        status: "passed",
        unresolved: Object.freeze([]),
        outputBytes: Object.freeze([1]),
      }),
  });
}
function failingSymbols(): CompilerSymbolAuthorityPort {
  return Object.freeze({
    inspect: () =>
      Object.freeze({
        status: "failed",
        unresolved: Object.freeze(["AdvisoryMissing"]),
        outputBytes: Object.freeze([2]),
      }),
  });
}
