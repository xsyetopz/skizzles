import { describe, expect, it } from "bun:test";
import {
  type ContextFragment,
  createContextFragment,
  createOutboundContextMiddleware,
} from "../../../src/paradigms/context/index.ts";

describe("outbound context middleware", () => {
  it("places ranked protected fragments at both absolute bookends", () => {
    const fragments = frozenFragments([
      fragment("notes", "supporting", false, 90, "middle notes"),
      fragment("syntax", "ast", true, 100, "AST EXACT"),
      fragment("requirements", "spec", true, 0, "SPEC EXACT"),
      fragment("api", "contract", true, 0, "CONTRACT EXACT"),
      fragment("example", "supporting", false, 10, "middle example"),
    ]);
    const middleware = createOutboundContextMiddleware();
    if (middleware === undefined) throw new Error("middleware config rejected");

    const first = middleware.build(Object.freeze({ fragments }));
    const second = middleware.build(Object.freeze({ fragments }));
    expect(first.status).toBe("built");
    expect(second.status).toBe("built");
    if (first.status !== "built" || second.status !== "built") return;

    expect(first.payload.sections).toEqual([
      "CONTRACT EXACT",
      "SPEC EXACT",
      "AST EXACT",
      "middle notes",
      "middle example",
      "AST EXACT",
      "SPEC EXACT",
      "CONTRACT EXACT",
    ]);
    expect(first.payload.sections[0]).toBe("CONTRACT EXACT");
    expect(first.payload.sections.at(-1)).toBe("CONTRACT EXACT");
    expect(
      first.payload.prioritization.placements.map(({ region }) => region),
    ).toEqual([
      "beginning",
      "beginning",
      "beginning",
      "middle",
      "middle",
      "end",
      "end",
      "end",
    ]);
    expect(first.payload.prioritization.receiptDigest).toBe(
      second.payload.prioritization.receiptDigest,
    );
    expect(first.payload.compression).toBeNull();
    expect(first.payload.beforeTokenEstimate).toBe(
      first.payload.afterTokenEstimate,
    );
    expect(
      middleware.verify(Object.freeze({ fragments, payload: first.payload })),
    ).toBe(true);
  });

  it("makes a singleton protected fragment an explicit exact bookend replica", () => {
    const protectedContent = "do not alter this contract\nincluding spacing";
    const fragments = frozenFragments([
      fragment("context", "supporting", false, 10, "middle"),
      fragment("contract", "contract", true, 100, protectedContent),
    ]);
    const middleware = createOutboundContextMiddleware();
    if (middleware === undefined) throw new Error("middleware config rejected");
    const result = middleware.build(Object.freeze({ fragments }));
    expect(result.status).toBe("built");
    if (result.status !== "built") return;
    expect(result.payload.sections).toEqual([
      protectedContent,
      "middle",
      protectedContent,
    ]);
    expect(result.payload.prioritization.placements.at(-1)).toMatchObject({
      fragmentId: "contract",
      occurrence: 1,
      region: "end",
    });
  });

  it("applies only auditable local compression and preserves protected bytes", () => {
    const protectedStart = "CONTRACT  spacing\nMUST remain";
    const protectedEnd = "SPEC\n\nexact";
    const fragments = frozenFragments([
      fragment(
        "low",
        "supporting",
        false,
        1,
        "low      value repeated repeated",
      ),
      fragment("contract", "contract", true, 100, protectedStart),
      fragment("high", "supporting", false, 90, "high       value"),
      fragment("spec", "spec", true, 100, protectedEnd),
    ]);
    const middleware = createOutboundContextMiddleware(
      Object.freeze({
        compression: Object.freeze({ enabled: true, targetTokenEstimate: 28 }),
      }),
    );
    if (middleware === undefined) throw new Error("middleware config rejected");
    const result = middleware.build(Object.freeze({ fragments }));
    expect(result.status).toBe("built");
    if (result.status !== "built") return;

    expect(result.payload.sections[0]).toBe(protectedStart);
    expect(result.payload.sections.at(-1)).toBe(protectedStart);
    expect(result.payload.sections).not.toContain(
      "low value repeated repeated",
    );
    expect(result.payload.sections).toContain("high value");
    expect(result.payload.compression).not.toBeNull();
    expect(result.payload.compression?.afterTokenEstimate).toBeLessThanOrEqual(
      28,
    );
    expect(result.payload.compression?.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fragmentId: "contract",
          action: "preserved",
          reason: "protected-fragment",
        }),
        expect.objectContaining({
          fragmentId: "low",
          action: "omitted",
          reason: "token-target",
        }),
        expect.objectContaining({
          fragmentId: "high",
          action: "whitespace-collapsed",
          reason: "whitespace-reduction",
        }),
      ]),
    );
    expect(Object.isFrozen(result.payload)).toBe(true);
    expect(Object.isFrozen(result.payload.sections)).toBe(true);
    expect(Object.isFrozen(result.payload.compression)).toBe(true);
    expect(Object.isFrozen(result.payload.compression?.decisions)).toBe(true);
    expect(Object.isFrozen(result.payload.compression?.decisions[0])).toBe(
      true,
    );
  });

  it("fails closed when the token target cannot contain protected bookends", () => {
    const fragments = frozenFragments([
      fragment("contract", "contract", true, 100, "protected content"),
    ]);
    const middleware = createOutboundContextMiddleware(
      Object.freeze({
        compression: Object.freeze({ enabled: true, targetTokenEstimate: 1 }),
      }),
    );
    if (middleware === undefined) throw new Error("middleware config rejected");
    expect(middleware.build(Object.freeze({ fragments }))).toEqual({
      status: "rejected",
      code: "TOKEN_TARGET_UNSATISFIABLE",
    });
  });
});

function fragment(
  id: string,
  kind: "ast" | "contract" | "spec" | "supporting",
  critical: boolean,
  priority: number,
  content: string,
): ContextFragment {
  const result = createContextFragment(
    Object.freeze({ id, kind, critical, priority, content }),
  );
  if (result.status !== "created") throw new Error("fragment fixture rejected");
  return result.fragment;
}

function frozenFragments(
  fragments: readonly ContextFragment[],
): readonly ContextFragment[] {
  return Object.freeze([...fragments]);
}
