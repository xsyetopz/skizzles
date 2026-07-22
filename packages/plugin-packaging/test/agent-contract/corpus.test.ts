import { afterEach, describe, expect, it } from "bun:test";
import { validateCanonicalAgentContracts } from "../../src/agent-contract/validation.ts";
import {
  createTestWorkspace,
  requiredTestArray,
  requiredTestRecord,
} from "../plugin/fixture.ts";
import { corpusCase, mutateJson } from "./publication-support.ts";

const TRUST_CORPUS =
  "skills/fourth-wall/fixtures/trust-boundary-incidents.json";
const ACCEPTANCE_CORPUS =
  "skills/completion-contract/fixtures/acceptance-incidents.json";

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("executable incident corpus composition", () => {
  it("rejects unknown corpus fields", async () => {
    const root = await fixture();
    await mutateJson(root, TRUST_CORPUS, (corpus) => {
      corpus["explanation"] = "undeclared field";
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "must contain exactly cases, controls, corpusVersion, evaluationOptions, schemaVersion",
    );
  });

  it("rejects altered materialized-input hashes", async () => {
    const root = await fixture();
    await mutateJson(root, ACCEPTANCE_CORPUS, (corpus) => {
      corpusCase(corpus, 0)["inputSha256"] = "0".repeat(64);
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "does not bind the materialized input",
    );
  });

  it("rejects reordered cases", async () => {
    const root = await fixture();
    await mutateJson(root, TRUST_CORPUS, (corpus) => {
      const cases = requiredTestArray(corpus["cases"], "cases");
      [cases[0], cases[1]] = [cases[1], cases[0]];
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "is out of canonical order",
    );
  });

  it("rejects stale corpus versions", async () => {
    const root = await fixture();
    await mutateJson(root, ACCEPTANCE_CORPUS, (corpus) => {
      corpus["corpusVersion"] = "1.0.0";
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "has a stale corpusVersion",
    );
  });

  it("rejects a case substituted with another case's materialized input", async () => {
    const root = await fixture();
    await mutateJson(root, TRUST_CORPUS, (corpus) => {
      const source = corpusCase(corpus, 5);
      const replacement = corpusCase(corpus, 15);
      replacement["mutations"] = JSON.parse(
        JSON.stringify(source["mutations"]),
      ) as unknown;
      replacement["inputSha256"] = source["inputSha256"];
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "duplicates materialized input from FW-006",
    );
  });

  for (const corpusPath of [TRUST_CORPUS, ACCEPTANCE_CORPUS]) {
    it(`rejects duplicate controls in ${corpusPath}`, async () => {
      const root = await fixture();
      await mutateJson(root, corpusPath, (corpus) => {
        const controls = requiredTestArray(corpus["controls"], "controls");
        const duplicate = JSON.parse(JSON.stringify(controls[0])) as Record<
          string,
          unknown
        >;
        duplicate["id"] = "DUPLICATE-CONTROL";
        controls.push(duplicate);
      });
      await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
        "duplicates input from",
      );
    });
  }

  it("rejects a rejecting case that collapses to its valid control", async () => {
    const root = await fixture();
    await mutateJson(root, TRUST_CORPUS, (corpus) => {
      const control = requiredTestRecord(
        requiredTestArray(corpus["controls"], "controls")[0],
        "control",
      );
      const incident = corpusCase(corpus, 2);
      incident["mutations"] = [];
      incident["inputSha256"] = control["inputSha256"];
    });
    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "duplicates control input",
    );
  });
});
