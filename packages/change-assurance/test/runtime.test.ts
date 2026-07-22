// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import { createChangeAssuranceExtension } from "../src/extension.ts";
import {
  type ChangeAssuranceDomain,
  createChangeAssurance,
  createChangeDeclaration,
  isChangeAssurance,
  isChangeAssuranceReceipt,
} from "../src/index.ts";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const domains = Object.freeze([
  "middleware-security",
  "migration-configuration-secrets",
  "performance",
  "supply-chain",
] satisfies readonly ChangeAssuranceDomain[]);

function createFacade() {
  const seen: unknown[] = [];
  const extensions = domains.map((domain) => {
    const created = createChangeAssuranceExtension({
      domain,
      id: `${domain}-authority`,
      version: "1.0.0",
      assess: (input: unknown) => {
        seen.push(input);
        return Object.freeze({
          status: "accepted" as const,
          evidenceDigest: digest("e"),
        });
      },
    });
    if (created.status !== "created") {
      throw new Error("extension setup failed");
    }
    return created.extension;
  });
  const created = createChangeAssurance(
    Object.freeze({ extensions: Object.freeze(extensions) }),
  );
  if (created.status !== "created") {
    throw new Error("assurance setup failed");
  }
  return { assurance: created.changeAssurance, seen };
}

function createDeclaration() {
  const created = createChangeDeclaration({
    requestDigest: digest("a"),
    repositoryId: "repository",
    targets: Object.freeze([
      Object.freeze({ path: "src/value.ts", operation: "write" as const }),
    ]),
    plans: Object.freeze({
      "middleware-security": Object.freeze({ entryPoints: Object.freeze([]) }),
      "migration-configuration-secrets": Object.freeze({
        migrations: Object.freeze([]),
      }),
      performance: Object.freeze({ benchmarks: Object.freeze([]) }),
      "supply-chain": Object.freeze({ packages: Object.freeze([]) }),
    }),
  });
  if (created.status !== "created") {
    throw new Error("declaration setup failed");
  }
  return created.declaration;
}

describe("change assurance facade", () => {
  it("binds exact immutable target bytes into an authentic digest-only receipt", async () => {
    const { assurance, seen } = createFacade();
    const baselineBytes = Object.freeze([1, 2, 3]);
    const candidateBytes = Object.freeze([1, 2, 4]);
    const targets = Object.freeze([
      Object.freeze({
        path: "src/value.ts",
        operation: "write" as const,
        baselineBytes,
        candidateBytes,
      }),
    ]);
    const assessment = Object.freeze({
      requestDigest: digest("a"),
      repositoryId: "repository",
      treeDigest: digest("b"),
      baselineDigest: digest("c"),
      declaration: createDeclaration(),
      targets,
    });
    const result = await assurance.assess(assessment);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") {
      return;
    }
    expect(isChangeAssuranceReceipt(result.receipt)).toBe(true);
    expect(
      assurance.verify(Object.freeze({ receipt: result.receipt, assessment })),
    ).toBe(true);
    expect(Object.keys(result.receipt)).not.toContain("targets");
    expect(JSON.stringify(result.receipt)).not.toContain("baselineBytes");
    expect(JSON.stringify(result.receipt)).not.toContain("candidateBytes");
    expect(seen).toHaveLength(4);
    const first = seen[0];
    expect(typeof first).toBe("object");
    if (typeof first !== "object" || first === null || !("targets" in first)) {
      return;
    }
    const observed = first.targets;
    expect(Array.isArray(observed)).toBe(true);
    if (!Array.isArray(observed)) {
      return;
    }
    expect(observed[0]?.baselineBytes).toBe(baselineBytes);
    expect(observed[0]?.candidateBytes).toBe(candidateBytes);
  });

  it("rejects method-copy facades, declarations, and mutable byte arrays", async () => {
    const { assurance } = createFacade();
    expect(isChangeAssurance(Object.freeze({ assess: assurance.assess }))).toBe(
      false,
    );
    const valid = Object.freeze({
      requestDigest: digest("a"),
      repositoryId: "repository",
      treeDigest: digest("b"),
      baselineDigest: digest("c"),
      declaration: createDeclaration(),
      targets: Object.freeze([
        Object.freeze({
          path: "src/value.ts",
          operation: "write" as const,
          baselineBytes: [1],
          candidateBytes: Object.freeze([2]),
        }),
      ]),
    });
    expect((await assurance.assess(valid)).status).toBe("rejected");
    const declaration = createDeclaration();
    const forged = Object.freeze({ ...declaration });
    expect(
      (await assurance.assess(Object.freeze({ ...valid, declaration: forged })))
        .status,
    ).toBe("rejected");
  });

  it("requires one authentic extension for every assurance domain", () => {
    const created = createChangeAssurance(
      Object.freeze({ extensions: Object.freeze([]) }),
    );
    expect(created).toEqual({ status: "rejected", code: "INVALID_CONFIG" });
    const { assurance } = createFacade();
    const fake = Object.freeze({ ...assurance });
    expect(isChangeAssurance(fake)).toBe(false);
  });

  it("contains proxy and accessor inputs without executing them", async () => {
    let reads = 0;
    const accessor = Object.freeze(
      Object.defineProperty({}, "requestDigest", {
        get() {
          reads += 1;
          return digest("a");
        },
      }),
    );
    expect(createChangeDeclaration(accessor)).toEqual({
      status: "rejected",
      code: "INVALID_DECLARATION",
    });
    const hostile = new Proxy(Object.freeze({}), {
      ownKeys() {
        throw new Error("proxy trap must not run");
      },
    });
    expect(createChangeDeclaration(hostile)).toEqual({
      status: "rejected",
      code: "INVALID_DECLARATION",
    });
    expect(createChangeAssurance(hostile)).toEqual({
      status: "rejected",
      code: "INVALID_CONFIG",
    });
    const { assurance } = createFacade();
    expect((await assurance.assess(hostile)).status).toBe("rejected");
    expect(reads).toBe(0);
  });
});
