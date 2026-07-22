// biome-ignore-all lint/security/noSecrets: Embedded candidate programs intentionally exercise literal-policy syntax, not credentials.
import { describe, expect, it } from "bun:test";
import {
  analyzeLiteralCases,
  findingCodes,
  registeredSnapshot,
} from "./fixture.ts";

const clientDeclaration = Object.freeze({
  productionPath: "src/client.ts",
  failureCodes: Object.freeze(["CONNECT_FAIL"]),
});
const clientNegativeTest = Object.freeze({
  productionPath: "src/client.ts",
  testPath: "test/client.test.ts",
});
const clientFaults = Object.freeze({
  declarations: Object.freeze([clientDeclaration]),
  negativeTests: Object.freeze([clientNegativeTest]),
});
const clientTest = Object.freeze({
  path: "test/client.test.ts",
  ownership: "test" as const,
  baseline: "export {};",
  candidate: 'expect(result.code).toBe("CONNECT_FAIL");',
});

describe("central literal policy", () => {
  it("rejects unregistered values while preserving typed syntax exemptions", async () => {
    const findings = await analyzeLiteralCases(
      [
        {
          path: "src/client.ts",
          ownership: "production",
          candidate: [
            'connect("tenant-a", 2500);',
            'if (tenant === "tenant-a") connect("tenant-a", 2500);',
            "items.at(-1);",
            "if (status === 0) recover();",

            'request("GET");',
            'throw new Error("tenant-a");',
          ].join("\n"),
        },
        clientTest,
      ],
      clientFaults,
    );

    expect(findingCodes(findings)).toEqual(
      Array.from({ length: 6 }, () => "UNREGISTERED_LITERAL"),
    );
  });

  it("rejects package-local constants as literal registration", async () => {
    const findings = await analyzeLiteralCases(
      [
        {
          path: "src/client.ts",
          ownership: "production",
          candidate: [
            "interface ClientPolicy { readonly tenant: string; readonly timeout: number; }",
            'const POLICY = { tenant: "tenant-a", timeout: 2500 } satisfies ClientPolicy;',
            "connect(POLICY.tenant, POLICY.timeout);",
            'if (tenant === "tenant-a") reconnect(POLICY.timeout);',
          ].join("\n"),
        },
        clientTest,
      ],
      clientFaults,
    );

    expect(findingCodes(findings)).toEqual([
      "UNREGISTERED_LITERAL",
      "UNREGISTERED_LITERAL",
      "UNREGISTERED_LITERAL",
    ]);
  });

  it("rejects scalar file-local constants without inline duplicates", async () => {
    const findings = await analyzeLiteralCases(
      [
        {
          path: "src/client.ts",
          ownership: "production",
          candidate: [
            'const ENDPOINT = "tenant-a";',
            "const TIMEOUT_MS = 2500;",
            "connect(ENDPOINT, TIMEOUT_MS);",
          ].join("\n"),
        },
        clientTest,
      ],
      clientFaults,
    );

    expect(findingCodes(findings)).toEqual([
      "UNREGISTERED_LITERAL",
      "UNREGISTERED_LITERAL",
    ]);
  });

  it("accepts authentic entries materialized in the centralized typed registry", async () => {
    const findings = await analyzeLiteralCases(
      [
        {
          path: "src/config/parameters.ts",
          ownership: "production",
          candidate: [
            "export const SOURCE_PARAMETERS = {",
            '  endpoint: "tenant-a",',
            "  timeoutMs: 2500,",
            "} satisfies Readonly<Record<string, string | number>>;",
          ].join("\n"),
        },
        {
          path: "src/client.ts",
          ownership: "production",
          candidate:
            "connect(SOURCE_PARAMETERS.endpoint, SOURCE_PARAMETERS.timeoutMs);",
        },
        {
          path: "test/parameters.test.ts",
          ownership: "test",
          baseline: "export {};",
          candidate: 'expect(result.code).toBe("CONFIG_FAIL");',
        },
        clientTest,
      ],
      Object.freeze({
        declarations: Object.freeze([
          Object.freeze({
            productionPath: "src/config/parameters.ts",
            failureCodes: Object.freeze(["CONFIG_FAIL"]),
          }),
          clientDeclaration,
        ]),
        negativeTests: Object.freeze([
          Object.freeze({
            productionPath: "src/config/parameters.ts",
            testPath: "test/parameters.test.ts",
          }),
          clientNegativeTest,
        ]),
      }),
      registeredSnapshot([
        {
          key: "endpoint",
          value: "tenant-a",
          description: "Stable tenant endpoint used by the client policy.",
        },
        {
          key: "timeoutMs",
          value: 2500,
          description: "Client connection timeout in milliseconds.",
        },
      ]),
    );

    expect(findingCodes(findings)).toEqual([]);
  });

  it("rejects an inline duplicate of a centrally registered value", async () => {
    const findings = await analyzeLiteralCases(
      [
        {
          path: "src/client.ts",
          ownership: "production",
          candidate: 'if (tenant === "tenant-a") connect();',
        },
        clientTest,
      ],
      clientFaults,
      registeredSnapshot([
        {
          key: "endpoint",
          value: "tenant-a",
          description: "Stable tenant endpoint used by the client policy.",
        },
      ]),
    );

    expect(findingCodes(findings)).toEqual(["UNREGISTERED_LITERAL"]);
  });
});
