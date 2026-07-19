// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import type { JsonValue } from "../../src/agent-contract/json/value.ts";
import { createTestWorkspace } from "../plugin/fixture.ts";
import {
  arrayAt,
  evaluateControl,
  loadControl,
  recordAt,
  rejectionCode,
  requiredValue,
} from "./support.ts";

const TRUST_CORPUS =
  "skills/fourth-wall/fixtures/trust-boundary-incidents.json";
const ZERO_DIGEST = "0".repeat(64);

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("handoff relational evaluation", () => {
  it("accepts the version-bound independent-review control", async () => {
    const control = await loadControl(
      await fixture(),
      TRUST_CORPUS,
      "FW-HANDOFF-CONTROL",
    );
    expect(() => evaluateControl(control)).not.toThrow();
  });

  for (const testCase of [
    {
      name: "self approval",
      code: "SELF_REVIEW",
      mutate(input: JsonValue) {
        recordAt(input, "authors")["reviewer"] = "author-agent";
      },
    },
    {
      name: "ineligible reviewer identity",
      code: "REVIEWER_MISMATCH",
      mutate(input: JsonValue) {
        recordAt(input, "authors")["reviewer"] = "arbitrary-reviewer";
      },
    },
    {
      name: "objective digest mismatch",
      code: "OBJECTIVE_MISMATCH",
      mutate(input: JsonValue) {
        recordAt(input, "objective")["digest"] = ZERO_DIGEST;
      },
    },
    {
      name: "acceptance digest mismatch",
      code: "ACCEPTANCE_MISMATCH",
      mutate(input: JsonValue) {
        recordAt(input, "acceptance")["digest"] = ZERO_DIGEST;
      },
    },
    {
      name: "acceptance reference mismatch",
      code: "ACCEPTANCE_MISMATCH",
      mutate(input: JsonValue) {
        recordAt(input, "acceptance")["ref"] = "contracts/unrelated.json";
      },
    },
    {
      name: "evidence outside input/artifact references",
      code: "REFERENCE_MISSING",
      mutate(input: JsonValue) {
        const evidence = arrayAt(input, "evidence");
        recordAt(requiredValue(evidence[0]), "")["ref"] = "unknown/ref";
      },
    },
    {
      name: "expired handoff",
      code: "CONTEXT_EXPIRED",
      mutate(input: JsonValue) {
        recordAt(input, "")["expiresAt"] = "2026-07-18T11:00:00Z";
      },
    },
  ] as const) {
    it(`rejects ${testCase.name}`, async () => {
      const control = await loadControl(
        await fixture(),
        TRUST_CORPUS,
        "FW-HANDOFF-CONTROL",
      );
      testCase.mutate(control.input);
      expect(rejectionCode(control)).toBe(testCase.code);
    });
  }
});
