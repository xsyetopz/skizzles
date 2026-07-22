// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import {
  type FormatterPassRequest,
  type FormatterPassResult,
} from "../../src/evidence/contract.ts";
import {
  formatTypeScriptCandidate,
  registerTypeScriptFormatterProfile,
} from "../../src/evidence/formatter.ts";
import type { ParsedTypeScriptSource } from "../../src/typescript/contract.ts";
import { parseTypeScriptSource } from "../../src/typescript/parser.ts";

const treeDigest = `sha256:${"1".repeat(64)}` as const;
const configDigest = `sha256:${"2".repeat(64)}` as const;
const candidateText = "export function value( ){return 1;}\n";
const formattedText = "export function value() { return 1; }\n";

describe("formatter authority evidence", () => {
  it("runs two bound passes and returns frozen semantic provenance", async () => {
    const calls: FormatterPassRequest[] = [];
    const profile = registeredProfile((request) => {
      calls.push(request);
      return formatterResult(request, formattedText);
    });
    expect(Object.isFrozen(profile)).toBe(true);
    const candidate = await parsedCandidate();

    const result = await formatTypeScriptCandidate({
      candidate,
      treeDigest,
      profile,
    });

    expect(result.status).toBe("formatted");
    if (result.status !== "formatted") {
      throw new Error(`formatter rejected valid evidence: ${result.code}`);
    }
    expect(calls.map(({ pass }) => pass)).toEqual([1, 2]);
    expect(calls[0]?.sourceText).toBe(candidateText);
    expect(calls[1]?.sourceText).toBe(formattedText);
    expect(calls[1]?.inputDigest).toBe(result.receipt.pass1Digest);
    expect(result.receipt).toMatchObject({
      path: "src/value.ts",
      profileId: "biome-typescript",
      tool: "biome",
      version: "2.5.4",
      treeDigest,
      configDigest,
    });
    expect(result.receipt.pass1Digest).toBe(result.receipt.pass2Digest);
    expect(result.receipt.formattedDigest).toBe(result.receipt.pass2Digest);
    expect(result.receipt.candidateSemanticDigest).toBe(
      result.receipt.formattedSemanticDigest,
    );
    expect(result.receipt.provenanceDigest).toStartWith("sha256:");
    expect(
      new TextDecoder().decode(Uint8Array.from(result.receipt.formattedBytes)),
    ).toBe(formattedText);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(result.receipt.formattedBytes)).toBe(true);
    expect(Object.isFrozen(calls[0])).toBe(true);
  });

  it("rejects every forged candidate and toolchain binding", async () => {
    const candidate = await parsedCandidate();
    const fields: readonly (keyof FormatterPassResult)[] = [
      "candidateDigest",
      "path",
      "treeDigest",
      "configDigest",
      "tool",
      "version",
      "profileId",
      "inputDigest",
      "pass",
    ];
    for (const field of fields) {
      const profile = registeredProfile((request) =>
        formatterResult(request, formattedText, field),
      );
      await expect(
        formatTypeScriptCandidate({ candidate, treeDigest, profile }),
      ).resolves.toEqual({
        status: "rejected",
        code: "FORMATTER_BINDING_MISMATCH",
      });
    }
  });

  it("rejects non-idempotent, syntax-changing, and semantic-changing passes", async () => {
    const candidate = await parsedCandidate();
    const unstable = registeredProfile((request) =>
      formatterResult(
        request,
        request.pass === 1 ? formattedText : `${formattedText}\n`,
      ),
    );
    await expect(
      formatTypeScriptCandidate({ candidate, treeDigest, profile: unstable }),
    ).resolves.toEqual({
      status: "rejected",
      code: "FORMATTER_NOT_IDEMPOTENT",
    });

    const syntaxChanging = registeredProfile((request) =>
      formatterResult(request, "export function value("),
    );
    await expect(
      formatTypeScriptCandidate({
        candidate,
        treeDigest,
        profile: syntaxChanging,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "FORMATTER_SYNTAX_REJECTED",
    });

    const semanticChanging = registeredProfile((request) =>
      formatterResult(request, "export function value() { return 2; }\n"),
    );
    await expect(
      formatTypeScriptCandidate({
        candidate,
        treeDigest,
        profile: semanticChanging,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "FORMATTER_SEMANTIC_DRIFT",
    });
  });

  it("rejects unregistered profiles and mutable or hostile authority results", async () => {
    const candidate = await parsedCandidate();
    await expect(
      formatTypeScriptCandidate({
        candidate,
        treeDigest,
        profile: Object.freeze({
          profileId: "forged",
          language: "typescript",
          tool: "biome",
          version: "2.5.4",
          configDigest,
        }),
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "UNREGISTERED_FORMATTER_PROFILE",
    });

    const mutable = registeredProfile((request) => ({
      ...requestBindings(request),
      formattedText,
    }));
    await expect(
      formatTypeScriptCandidate({ candidate, treeDigest, profile: mutable }),
    ).resolves.toEqual({
      status: "rejected",
      code: "FORMATTER_RESULT_INVALID",
    });

    const hostile = registeredProfile(
      () =>
        new Proxy(Object.freeze({}), {
          ownKeys(): never {
            throw new Error("hostile formatter result");
          },
        }),
    );
    await expect(
      formatTypeScriptCandidate({ candidate, treeDigest, profile: hostile }),
    ).resolves.toEqual({
      status: "rejected",
      code: "FORMATTER_REJECTED",
    });
  });

  it("strictly registers profiles without invoking accessor input", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperties(
      {},
      {
        profileId: {
          enumerable: true,
          get(): string {
            getterCalls += 1;
            return "forged";
          },
        },
        language: { enumerable: true, value: "typescript" },
        tool: { enumerable: true, value: "biome" },
        version: { enumerable: true, value: "2.5.4" },
        configDigest: { enumerable: true, value: configDigest },
        authority: {
          enumerable: true,
          value: { format: () => Object.freeze({}) },
        },
      },
    );

    expect(registerTypeScriptFormatterProfile(accessor)).toEqual({
      status: "rejected",
      code: "INVALID_FORMATTER_PROFILE",
    });
    expect(getterCalls).toBe(0);
  });
});

function registeredProfile(format: (request: FormatterPassRequest) => unknown) {
  const result = registerTypeScriptFormatterProfile({
    profileId: "biome-typescript",
    language: "typescript",
    tool: "biome",
    version: "2.5.4",
    configDigest,
    authority: { format },
  });
  if (result.status !== "registered") {
    throw new Error("valid formatter profile was rejected");
  }
  return result.profile;
}

function formatterResult(
  request: FormatterPassRequest,
  output: string,
  forgedField?: keyof FormatterPassResult,
): unknown {
  const result: Record<keyof FormatterPassResult, string | number> = {
    ...requestBindings(request),
    formattedText: output,
  };
  if (forgedField !== undefined) {
    result[forgedField] = forgedBinding(forgedField, request);
  }
  return Object.freeze(result);
}

function forgedBinding(
  field: keyof FormatterPassResult,
  request: FormatterPassRequest,
): string | number {
  if (field === "pass") {
    return request.pass === 1 ? 2 : 1;
  }
  if (
    field === "candidateDigest" ||
    field === "inputDigest" ||
    field === "treeDigest" ||
    field === "configDigest"
  ) {
    return `sha256:${"f".repeat(64)}`;
  }
  if (field === "path") {
    return "src/forged.ts";
  }
  return "forged";
}

function requestBindings(request: FormatterPassRequest) {
  return {
    pass: request.pass,
    profileId: request.profileId,
    path: request.path,
    treeDigest: request.treeDigest,
    configDigest: request.configDigest,
    tool: request.tool,
    version: request.version,
    candidateDigest: request.candidateDigest,
    inputDigest: request.inputDigest,
  };
}

async function parsedCandidate(): Promise<ParsedTypeScriptSource> {
  const result = await parseTypeScriptSource({
    targetPath: "src/value.ts",
    sourceText: candidateText,
  });
  if (result.status !== "parsed") {
    throw new Error(`candidate parser rejected valid source: ${result.code}`);
  }
  return result.parsed;
}
