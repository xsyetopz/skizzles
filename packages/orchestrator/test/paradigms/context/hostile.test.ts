import { describe, expect, it } from "bun:test";
import {
  createContextFragment,
  createOutboundContextMiddleware,
  createSpecificationContextAuthority,
  isContextFragment,
  isOutboundContextMiddleware,
  isSpecificationContextAuthority,
} from "../../../src/paradigms/context/index.ts";

describe("context middleware trust boundary", () => {
  it("rejects mutable containers, aliases, forged fragments, and duplicate ids", () => {
    const created = createContextFragment(
      Object.freeze({
        id: "contract",
        kind: "contract",
        critical: true,
        priority: 100,
        content: "exact",
      }),
    );
    if (created.status !== "created") throw new Error("fixture rejected");
    const middleware = createOutboundContextMiddleware();
    if (middleware === undefined) throw new Error("middleware config rejected");

    expect(middleware.build({ fragments: [created.fragment] })).toMatchObject({
      status: "rejected",
      code: "INVALID_CONTEXT_INPUT",
    });
    expect(
      middleware.build(Object.freeze({ fragments: [created.fragment] })),
    ).toMatchObject({ status: "rejected", code: "INVALID_CONTEXT_INPUT" });
    expect(
      middleware.build(
        Object.freeze({
          fragments: Object.freeze([{ ...created.fragment }]),
        }),
      ),
    ).toMatchObject({ status: "rejected", code: "INVALID_CONTEXT_INPUT" });
    expect(
      middleware.build(
        Object.freeze({
          fragments: Object.freeze([created.fragment, created.fragment]),
        }),
      ),
    ).toMatchObject({ status: "rejected", code: "INVALID_CONTEXT_INPUT" });
    expect(isContextFragment(Object.freeze({ ...created.fragment }))).toBe(
      false,
    );
  });

  it("rejects accessors and proxies without invoking hostile code", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "fragments", {
      enumerable: true,
      get(): readonly never[] {
        reads += 1;
        return Object.freeze([]);
      },
    });
    Object.freeze(accessor);
    const middleware = createOutboundContextMiddleware();
    if (middleware === undefined) throw new Error("middleware config rejected");
    expect(middleware.build(accessor)).toMatchObject({ status: "rejected" });
    expect(reads).toBe(0);

    let traps = 0;
    const proxy = new Proxy(Object.freeze([]), {
      ownKeys(): ArrayLike<string | symbol> {
        traps += 1;
        return ["length"];
      },
    });
    expect(middleware.build(Object.freeze({ fragments: proxy }))).toMatchObject(
      { status: "rejected" },
    );
    expect(traps).toBe(0);
  });

  it("binds verification to the issuing facade, payload, and exact input", () => {
    const first = createContextFragment(
      Object.freeze({
        id: "first",
        kind: "contract",
        critical: true,
        priority: 100,
        content: "first",
      }),
    );
    const second = createContextFragment(
      Object.freeze({
        id: "second",
        kind: "contract",
        critical: true,
        priority: 100,
        content: "second",
      }),
    );
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("fixture rejected");
    }
    const firstFragments = Object.freeze([first.fragment]);
    const secondFragments = Object.freeze([second.fragment]);
    const middleware = createOutboundContextMiddleware();
    const other = createOutboundContextMiddleware();
    if (middleware === undefined || other === undefined) {
      throw new Error("middleware config rejected");
    }
    const result = middleware.build(
      Object.freeze({ fragments: firstFragments }),
    );
    if (result.status !== "built") throw new Error("fixture build rejected");
    const proof = Object.freeze({
      fragments: firstFragments,
      payload: result.payload,
    });
    expect(middleware.verify(proof)).toBe(true);
    expect(
      middleware.verify({ fragments: firstFragments, payload: result.payload }),
    ).toBe(false);
    expect(
      middleware.verify(
        Object.freeze({ fragments: secondFragments, payload: result.payload }),
      ),
    ).toBe(false);
    expect(
      middleware.verify(
        Object.freeze({
          fragments: firstFragments,
          payload: Object.freeze({ ...result.payload }),
        }),
      ),
    ).toBe(false);
    expect(other.verify(proof)).toBe(false);

    const lookalike = Object.freeze({ ...middleware });
    expect(isOutboundContextMiddleware(lookalike)).toBe(false);
    expect(lookalike.verify(proof)).toBe(false);
    const copiedBuild = middleware.build;
    expect(copiedBuild(Object.freeze({ fragments: firstFragments }))).toEqual({
      status: "rejected",
      code: "INVALID_CONTEXT_INPUT",
    });
  });

  it("rejects unrecognized compression and live-provider configuration", () => {
    expect(
      createOutboundContextMiddleware(
        Object.freeze({ liveApi: Object.freeze({ endpoint: "network" }) }),
      ),
    ).toBeUndefined();
    expect(
      createOutboundContextMiddleware(
        Object.freeze({
          compression: Object.freeze({
            enabled: false,
            targetTokenEstimate: 10,
          }),
        }),
      ),
    ).toBeUndefined();
    expect(
      createOutboundContextMiddleware(
        Object.freeze({
          compression: Object.freeze({ enabled: true }),
        }),
      ),
    ).toBeUndefined();
  });

  it("authenticates immutable configured specifications and rejects copies", () => {
    const created = createSpecificationContextAuthority(
      Object.freeze({
        specifications: Object.freeze([
          Object.freeze({ id: "architecture", content: "exact specification" }),
        ]),
      }),
    );
    if (created.status !== "created") throw new Error("specification rejected");
    expect(isSpecificationContextAuthority(created.authority)).toBe(true);
    expect(
      isSpecificationContextAuthority(Object.freeze({ ...created.authority })),
    ).toBe(false);
    expect(created.authority.fragments()).toMatchObject([
      { id: "spec.architecture", kind: "spec", critical: true },
    ]);
    expect(Object.isFrozen(created.authority.fragments())).toBe(true);
    expect(createSpecificationContextAuthority({ specifications: [] })).toEqual(
      {
        status: "rejected",
        code: "INVALID_SPECIFICATION_CONTEXT",
      },
    );
  });
});
