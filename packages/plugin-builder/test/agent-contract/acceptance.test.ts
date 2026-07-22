import { afterEach, describe, expect, it } from "bun:test";
import { createTestWorkspace } from "../plugin/fixture.ts";
import {
  acceptanceMutation,
  arrayAt,
  cloneJson,
  evaluateControl,
  firstGate,
  loadControl,
  recordAt,
  rejectionCode,
  requiredValue,
  trustAcceptanceRecord,
} from "./support.ts";

const ACCEPTANCE_CORPUS =
  "skills/completion-contract/fixtures/acceptance-incidents.json";
const ZERO_DIGEST = "0".repeat(64);

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

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
