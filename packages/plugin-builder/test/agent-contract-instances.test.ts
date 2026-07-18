// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import type { JsonValue } from "../src/agent-contract/json-value.ts";
import {
  acceptanceMutation,
  arrayAt,
  cloneJson,
  evaluateControl,
  firstGate,
  loadControl,
  propertyAt,
  recordAt,
  rejectionCode,
  requiredValue,
  trustAcceptanceRecord,
} from "./agent-contract-test-support.ts";
import { createTestWorkspace } from "./plugin-package-fixture.ts";

const TRUST_CORPUS =
  "skills/fourth-wall/fixtures/trust-boundary-incidents.json";
const ACCEPTANCE_CORPUS =
  "skills/completion-contract/fixtures/acceptance-incidents.json";
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

describe("acceptance causal evaluation", () => {
  it("accepts objective gates backed by artifact and observed-effect evidence", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    expect(() => evaluateControl(control)).not.toThrow();
  });

  for (const testCase of [
    acceptanceMutation(
      "duplicate requirements",
      "REQUIREMENT_DUPLICATE",
      (input) => {
        const requirements = arrayAt(input, "requirements");
        requirements.push(cloneJson(requiredValue(requirements[0])));
      },
    ),
    acceptanceMutation(
      "non-contiguous gate order",
      "GATE_ORDER_INVALID",
      (input) => {
        firstGate(input)["order"] = 2;
      },
    ),
    acceptanceMutation(
      "unknown gate requirement",
      "GATE_REQUIREMENT_UNKNOWN",
      (input) => {
        firstGate(input)["requirementId"] = "REQ-UNKNOWN";
      },
    ),
    acceptanceMutation("retry overflow", "RETRY_LIMIT_EXCEEDED", (input) => {
      recordAt(input, "execution")["retries"] = 3;
    }),
    acceptanceMutation("judge before gates", "JUDGE_ORDER_INVALID", (input) => {
      recordAt(input, "")["evaluationOrder"] = ["judge", "objectiveGates"];
    }),
    acceptanceMutation("author self approval", "SELF_REVIEW", (input) => {
      recordAt(input, "authors")["reviewer"] = "author-agent";
    }),
    acceptanceMutation(
      "unrelated objective replay",
      "OBJECTIVE_MISMATCH",
      (input) => {
        recordAt(input, "objective")["digest"] = ZERO_DIGEST;
      },
    ),
    acceptanceMutation(
      "unrelated acceptance replay",
      "ACCEPTANCE_MISMATCH",
      (input) => {
        recordAt(input, "acceptance")["digest"] = ZERO_DIGEST;
      },
    ),
    acceptanceMutation("verifier mutation", "VERIFIER_MUTATION", (input) => {
      recordAt(requiredValue(arrayAt(input, "artifacts")[1]), "")["sha256"] =
        ZERO_DIGEST;
    }),
    acceptanceMutation("test mutation", "TEST_MUTATION", (input) => {
      recordAt(requiredValue(arrayAt(input, "artifacts")[2]), "")["sha256"] =
        ZERO_DIGEST;
    }),
    acceptanceMutation("fake effect", "FAKE_EFFECT", (input) => {
      recordAt(requiredValue(arrayAt(input, "effects")[0]), "")["observed"] =
        false;
    }),
    acceptanceMutation(
      "unbound effect evidence",
      "EVIDENCE_BINDING_INVALID",
      (input) => {
        recordAt(requiredValue(arrayAt(input, "evidence")[2]), "")[
          "effectRef"
        ] = "effect/unknown";
      },
    ),
    acceptanceMutation(
      "failed objective gate",
      "OBJECTIVE_GATE_FAILED",
      (input) => {
        firstGate(input)["result"] = "fail";
      },
    ),
  ] as const) {
    it(`rejects ${testCase.name}`, async () => {
      const control = await loadControl(
        await fixture(),
        ACCEPTANCE_CORPUS,
        "CC-ACCEPTANCE-CONTROL",
      );
      testCase.mutate(control.input);
      expect(rejectionCode(control)).toBe(testCase.code);
    });
  }

  for (const finding of [
    ["solution-leakage", "SOLUTION_LEAKAGE"],
    ["grader-injection", "GRADER_INJECTION"],
    ["hard-coded-answer", "HARD_CODED_ANSWER"],
    ["deceptive-completion", "DECEPTIVE_COMPLETION"],
  ] as const) {
    it(`rejects ${finding[0]} findings`, async () => {
      const control = await loadControl(
        await fixture(),
        ACCEPTANCE_CORPUS,
        "CC-ACCEPTANCE-CONTROL",
      );
      recordAt(control.input, "")["findings"] = [
        { kind: finding[0], ref: "evidence/finding.json" },
      ];
      expect(rejectionCode(control)).toBe(finding[1]);
    });
  }

  it("rejects inspection/hash-only objective evidence as non-causal", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    firstGate(control.input)["evidenceRefs"] = ["evidence/verifier"];
    expect(rejectionCode(control)).toBe("EVIDENCE_NON_CAUSAL");
  });

  it("accepts a test-specific gate only with trusted test-suite results", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    firstGate(control.input)["proofKind"] = "test-result";
    firstGate(control.input)["evidenceRefs"] = ["evidence/tests"];
    trustAcceptanceRecord(control);
    expect(() => evaluateControl(control)).not.toThrow();
  });

  it("rejects a runtime gate backed only by a test result", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    firstGate(control.input)["evidenceRefs"] = ["evidence/tests"];
    expect(rejectionCode(control)).toBe("EVIDENCE_NON_CAUSAL");
  });

  it("rejects test-result evidence bound to implementation", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    const evidence = recordAt(
      requiredValue(arrayAt(control.input, "evidence")[1]),
      "",
    );
    evidence["artifactRef"] = "artifacts/implementation.js";
    evidence["sha256"] = "1".repeat(64);
    expect(rejectionCode(control)).toBe("EVIDENCE_BINDING_INVALID");
  });

  it("rejects fabricated observed effects against trusted negative facts", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    control.options = {
      ...control.options,
      expectedEffects: new Map([
        [
          "effect/runtime",
          {
            observed: false,
            evidenceId: "evidence/runtime",
            evidenceRef: "evidence/runtime.json",
          },
        ],
      ]),
    };
    expect(rejectionCode(control)).toBe("FAKE_EFFECT");
  });

  it("rejects runtime evidence whose external reference differs from trusted facts", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    recordAt(requiredValue(arrayAt(control.input, "evidence")[2]), "")["ref"] =
      "evidence/fabricated.json";
    expect(rejectionCode(control)).toBe("EVIDENCE_BINDING_INVALID");
  });

  it("rejects SCOPE_SHRUNK_WITH_UNCHANGED_TRUSTED_ACCEPTANCE_DIGEST", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    recordAt(requiredValue(arrayAt(control.input, "requirements")[0]), "")[
      "obligation"
    ] = "Run less work.";
    expect(rejectionCode(control)).toBe("ACCEPTANCE_MISMATCH");
  });

  it("rejects UNTRUSTED_EXTRA_TEST_RESULT", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    const extra = cloneJson(
      requiredValue(arrayAt(control.input, "evidence")[1]),
    );
    recordAt(extra, "")["id"] = "evidence/untrusted-extra";
    arrayAt(control.input, "evidence").push(extra);
    expect(rejectionCode(control)).toBe("EVIDENCE_BINDING_INVALID");
  });

  it("rejects omission of a trusted test result", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    arrayAt(control.input, "evidence").splice(1, 1);
    expect(rejectionCode(control)).toBe("REFERENCE_MISSING");
  });

  it("rejects trusted test result digest or outcome mismatch", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    recordAt(requiredValue(arrayAt(control.input, "evidence")[1]), "")[
      "sha256"
    ] = ZERO_DIGEST;
    expect(rejectionCode(control)).toBe("EVIDENCE_BINDING_INVALID");
  });

  it("rejects FORGED_REVIEWER_AND_SELF_REPORTED_JUDGE", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    recordAt(control.input, "authors")["reviewer"] = "arbitrary-reviewer";
    recordAt(control.input, "judge")["decision"] = "fail";
    expect(rejectionCode(control)).toBe("JUDGE_MISMATCH");
  });

  it("rejects an ineligible arbitrary reviewer identity", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    recordAt(control.input, "authors")["reviewer"] = "arbitrary-reviewer";
    expect(rejectionCode(control)).toBe("REVIEWER_MISMATCH");
  });

  it("rejects omission of a trusted deceptive-completion finding", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    control.options = {
      ...control.options,
      expectedFindings: [
        { kind: "deceptive-completion", ref: "evidence/known.json" },
      ],
    };
    expect(rejectionCode(control)).toBe("DECEPTIVE_COMPLETION");
  });

  it("rejects replayed run identities", async () => {
    const control = await loadControl(
      await fixture(),
      ACCEPTANCE_CORPUS,
      "CC-ACCEPTANCE-CONTROL",
    );
    control.options = {
      ...control.options,
      run: {
        ...control.options.run,
        priorRunIds: new Set([control.options.run.id]),
      },
    };
    expect(rejectionCode(control)).toBe("REPLAY_DETECTED");
  });

  for (const nonCausal of [
    ["process-exit", "evidence/exit", "EXIT_ZERO_ONLY"],
    ["success-token", "evidence/token", "SUCCESS_TOKEN_ONLY"],
  ] as const) {
    it(`rejects ${nonCausal[0]}-only completion evidence`, async () => {
      const control = await loadControl(
        await fixture(),
        ACCEPTANCE_CORPUS,
        "CC-ACCEPTANCE-CONTROL",
      );
      const evidence = arrayAt(control.input, "evidence");
      evidence.push({
        id: nonCausal[1],
        kind: nonCausal[0],
        ref: `${nonCausal[1]}.json`,
        artifactRef: null,
        effectRef: null,
        sha256: null,
        outcome: "pass",
      });
      firstGate(control.input)["evidenceRefs"] = [nonCausal[1]];
      expect(rejectionCode(control)).toBe(nonCausal[2]);
    });
  }
});
