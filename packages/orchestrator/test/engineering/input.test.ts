import { describe, expect, it } from "bun:test";
import { createChangeDeclaration } from "@skizzles/change-assurance";
import type { EngineeringValidationProfile } from "../../src/engineering/contract.ts";
import { parseEngineeringInput } from "../../src/engineering/input/parse.ts";
import { createHarness, repositoryContext } from "../facade/support.ts";

const digest = `sha256:${"a".repeat(64)}`;
const profiles: readonly EngineeringValidationProfile[] = Object.freeze([
  Object.freeze({
    id: "strict",
    language: "typescript",
    objective: "behavioral",
    formatterId: "biome",
    commandProfileIds: Object.freeze(["validate"]),
    negativeTestCommands: Object.freeze([
      Object.freeze({
        profileId: "negative-test",
        testPaths: Object.freeze(["test/example.test.ts"]),
      }),
    ]),
  }),
]);

describe("engineering public input", () => {
  it("accepts bounded AST fragments and fault declarations", async () => {
    const input = await validInput();
    expect(parseEngineeringInput(input, profiles)).toMatchObject({
      validationProfile: "strict",
      targets: [
        {
          path: "src/example.ts",
          operations: [{ kind: "replace", templateId: "function-template" }],
        },
      ],
    });
    expect(
      parseEngineeringInput(
        input,
        Object.freeze([
          Object.freeze({
            id: "strict",
            language: "typescript",
            objective: "behavioral",
            formatterId: "biome",
            commandProfileIds: Object.freeze(["validate"]),
            negativeTestCommands: Object.freeze([]),
          }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("rejects candidate bytes, regex replacements, cwd, and caller commands", async () => {
    const input = await validInput();
    for (const forbidden of [
      { candidateBytes: [1] },
      { regex: "unsafe" },
      { cwd: "/tmp" },
      { commands: ["arbitrary"] },
    ]) {
      expect(
        parseEngineeringInput({ ...input, ...forbidden }, profiles),
      ).toBeUndefined();
    }
  });

  it("rejects accessors and proxies without invoking their traps", async () => {
    const input = await validInput();
    let reads = 0;
    const hostileTarget = Object.defineProperty({}, "path", {
      enumerable: true,
      get(): string {
        reads += 1;
        return "src/example.ts";
      },
    });
    Object.defineProperty(hostileTarget, "operations", {
      enumerable: true,
      value: input.targets[0]?.operations,
    });
    expect(
      parseEngineeringInput({ ...input, targets: [hostileTarget] }, profiles),
    ).toBeUndefined();
    expect(reads).toBe(0);

    let traps = 0;
    const targets = new Proxy(input.targets, {
      ownKeys(): ArrayLike<string | symbol> {
        traps += 1;
        return ["0", "length"];
      },
    });
    expect(
      parseEngineeringInput({ ...input, targets }, profiles),
    ).toBeUndefined();
    expect(traps).toBe(0);
  });
});

async function validInput() {
  const harness = createHarness();
  const context = await repositoryContext(harness.orchestrator);
  const declaration = createChangeDeclaration(
    Object.freeze({
      requestDigest: context.request.intentDigest,
      repositoryId: context.repository.repositoryId,
      targets: Object.freeze([
        Object.freeze({ path: "src/example.ts", operation: "write" }),
      ]),
      plans: Object.freeze({
        "middleware-security": Object.freeze({}),
        "migration-configuration-secrets": Object.freeze({}),
        performance: Object.freeze({}),
        "supply-chain": Object.freeze({}),
      }),
    }),
  );
  if (declaration.status !== "created") {
    throw new Error("change declaration fixture rejected");
  }
  return Object.freeze({
    ...context,
    context: Object.freeze({ opaque: true }),
    changeDeclaration: declaration.declaration,
    targets: Object.freeze([
      Object.freeze({
        path: "src/example.ts",
        operations: Object.freeze([
          Object.freeze({
            kind: "replace",
            selector: Object.freeze({
              declarationKind: "function",
              name: "run",
              expectedNodeDigest: digest,
            }),
            templateId: "function-template",
            nodeSource: "export function run(): boolean { return true; }",
          }),
        ]),
      }),
    ]),
    faultDeclarations: Object.freeze({
      declarations: Object.freeze([
        Object.freeze({
          productionPath: "src/example.ts",
          failureCodes: Object.freeze(["INVALID_INPUT"]),
        }),
      ]),
      negativeTests: Object.freeze([
        Object.freeze({
          productionPath: "src/example.ts",
          testPath: "test/example.test.ts",
        }),
      ]),
    }),
    validationProfile: "strict",
    integrations: Object.freeze([]),
  });
}
