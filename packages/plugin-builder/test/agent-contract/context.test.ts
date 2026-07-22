import { afterEach, describe, expect, it } from "bun:test";
import type { JsonValue } from "../../src/agent-contract/json/value.ts";
import { createTestWorkspace } from "../plugin/fixture.ts";
import {
  arrayAt,
  cloneJson,
  evaluateControl,
  loadControl,
  propertyAt,
  recordAt,
  rejectionCode,
  requiredValue,
} from "./support.ts";

const TRUST_CORPUS =
  "skills/fourth-wall/fixtures/trust-boundary-incidents.json";
const ZERO_DIGEST = "0".repeat(64);

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("context envelope relational evaluation", () => {
  it("accepts the integrity-bound model transformation control", async () => {
    const control = await loadControl(
      await fixture(),
      TRUST_CORPUS,
      "FW-CONTEXT-CONTROL",
    );
    expect(() => evaluateControl(control)).not.toThrow();
  });

  for (const testCase of [
    {
      name: "duplicate property names",
      code: "CONTEXT_PROPERTY_DUPLICATE",
      mutate(input: JsonValue) {
        const properties = arrayAt(input, "properties");
        properties.push(cloneJson(requiredValue(properties[0])));
      },
    },
    {
      name: "incomplete integrity coverage",
      code: "INTEGRITY_MISMATCH",
      mutate(input: JsonValue) {
        propertyAt(input)["integrity"] = {
          ...recordAt(propertyAt(input), "integrity"),
          coverage: "whole-envelope",
        };
      },
    },
    {
      name: "property-mismatched model validation",
      code: "VALIDATOR_MISMATCH",
      mutate(input: JsonValue) {
        recordAt(propertyAt(input), "validation")["property"] = "other";
      },
    },
    {
      name: "property mismatch even when the value is untrusted",
      code: "VALIDATOR_MISMATCH",
      mutate(input: JsonValue) {
        propertyAt(input)["trustClass"] = "untrusted";
        recordAt(propertyAt(input), "validation")["property"] = "other";
      },
    },
    {
      name: "validation before the final transformation",
      code: "CHRONOLOGY_INVALID",
      mutate(input: JsonValue) {
        recordAt(propertyAt(input), "validation")["validatedAt"] =
          "2026-07-18T10:01:30Z";
      },
    },
    {
      name: "normalized invalid calendar date",
      code: "INSTANCE_SHAPE",
      mutate(input: JsonValue) {
        propertyAt(input)["createdAt"] = "2026-02-31T10:00:00Z";
      },
    },
    {
      name: "validator-version mismatch",
      code: "VALIDATOR_MISMATCH",
      mutate(input: JsonValue) {
        recordAt(recordAt(propertyAt(input), "validation"), "validator")[
          "version"
        ] = "1.0.0";
      },
    },
    {
      name: "empty deterministic evidence",
      code: "LLM_TRANSFORM_UNVALIDATED",
      mutate(input: JsonValue) {
        recordAt(propertyAt(input), "validation")["evidence"] = [];
      },
    },
    {
      name: "expired retention",
      code: "CONTEXT_EXPIRED",
      mutate(input: JsonValue) {
        recordAt(propertyAt(input), "retention")["expiresAt"] =
          "2026-07-18T11:00:00Z";
      },
    },
    {
      name: "future retrieval chronology",
      code: "CHRONOLOGY_INVALID",
      mutate(input: JsonValue) {
        propertyAt(input)["retrievedAt"] = "2026-07-18T13:00:00Z";
      },
    },
    {
      name: "secret without applied redaction",
      code: "SECRET_REDACTION_REQUIRED",
      mutate(input: JsonValue) {
        propertyAt(input)["sensitivity"] = "secret";
      },
    },
    {
      name: "policy digest mismatch",
      code: "POLICY_MISMATCH",
      mutate(input: JsonValue) {
        recordAt(propertyAt(input), "policy")["digest"] = ZERO_DIGEST;
      },
    },
    {
      name: "model producer digest mismatch",
      code: "MODEL_MISMATCH",
      mutate(input: JsonValue) {
        const transformations = arrayAt(propertyAt(input), "transformations");
        recordAt(recordAt(requiredValue(transformations[0]), "producer"), "")[
          "digest"
        ] = ZERO_DIGEST;
      },
    },
  ] as const) {
    it(`rejects ${testCase.name}`, async () => {
      const control = await loadControl(
        await fixture(),
        TRUST_CORPUS,
        "FW-CONTEXT-CONTROL",
      );
      testCase.mutate(control.input);
      expect(rejectionCode(control)).toBe(testCase.code);
    });
  }

  it("rejects UNTRUSTED_PROPERTY_MISMATCH for an invalid untrusted value", async () => {
    const control = await loadControl(
      await fixture(),
      TRUST_CORPUS,
      "FW-CONTEXT-CONTROL",
    );
    const property = propertyAt(control.input);
    property["trustClass"] = "untrusted";
    const validation = recordAt(property, "validation");
    validation["property"] = "other";
    validation["status"] = "invalid";
    validation["validator"] = null;
    validation["validatedAt"] = null;
    validation["evidence"] = [];
    expect(rejectionCode(control)).toBe("VALIDATOR_MISMATCH");
  });
});
