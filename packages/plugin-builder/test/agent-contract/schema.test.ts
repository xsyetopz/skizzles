// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateCanonicalAgentContracts } from "../../src/agent-contract/validation.ts";
import { createTestWorkspace } from "../plugin/fixture.ts";
import {
  mutateJson,
  objectAt,
  rejectionMessage,
  replaceRaw,
} from "./publication-support.ts";

const CONTEXT_SCHEMA =
  "skills/fourth-wall/contracts/context-envelope.schema.json";
const HANDOFF_SCHEMA =
  "skills/fourth-wall/contracts/handoff-review.schema.json";
const TRUST_CORPUS =
  "skills/fourth-wall/fixtures/trust-boundary-incidents.json";
const ACCEPTANCE_SCHEMA =
  "skills/completion-contract/contracts/acceptance.schema.json";

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("pinned agent contract publications", () => {
  it("validates exact schemas and executes every materialized incident case", async () => {
    const root = await fixture();
    await expect(
      validateCanonicalAgentContracts(root),
    ).resolves.toBeUndefined();
  });

  for (const mutant of [
    {
      name: "erased validation statuses",
      path: CONTEXT_SCHEMA,
      mutate(schema: Record<string, unknown>) {
        objectAt(
          schema,
          "$defs.contextProperty.properties.validation.properties.status",
        )["enum"] = ["valid"];
      },
    },
    {
      name: "non-date createdAt format",
      path: CONTEXT_SCHEMA,
      mutate(schema: Record<string, unknown>) {
        objectAt(schema, "$defs.contextProperty.properties.createdAt")[
          "format"
        ] = "email";
      },
    },
    {
      name: "dangling local definition reference",
      path: CONTEXT_SCHEMA,
      mutate(schema: Record<string, unknown>) {
        objectAt(schema, "properties.properties.items")["$ref"] =
          "#/$defs/missing";
      },
    },
    {
      name: "negative minLength",
      path: HANDOFF_SCHEMA,
      mutate(schema: Record<string, unknown>) {
        objectAt(schema, "properties.objective.properties.statement")[
          "minLength"
        ] = -1;
      },
    },
    {
      name: "non-causal evidence-only enum",
      path: ACCEPTANCE_SCHEMA,
      mutate(schema: Record<string, unknown>) {
        objectAt(schema, "properties.evidence.items.properties.kind")["enum"] =
          ["inspection", "artifact-hash"];
      },
    },
    {
      name: "unconstrained objective check",
      path: ACCEPTANCE_SCHEMA,
      mutate(schema: Record<string, unknown>) {
        delete objectAt(
          schema,
          "properties.objectiveGates.items.properties.check",
        )["minLength"];
      },
    },
  ] as const) {
    it(`rejects ${mutant.name}`, async () => {
      const root = await fixture();
      await mutateJson(root, mutant.path, mutant.mutate);

      await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
        "does not match its pinned publication",
      );
    });
  }

  it("rejects malformed JSON with a stable redacted diagnostic", async () => {
    const root = await fixture();
    await writeFile(join(root, CONTEXT_SCHEMA), "not JSON\n");

    const message = await rejectionMessage(
      validateCanonicalAgentContracts(root),
    );
    expect(message).toBe("canonical Fourth Wall schema is not valid JSON.");
    expect(message).not.toContain(root);
    expect(message).not.toContain("SyntaxError");
  });

  it("rejects conflicting duplicate acceptance refs in evaluator options", async () => {
    const root = await fixture();
    await replaceRaw(
      root,
      TRUST_CORPUS,
      '      "ref": "contracts/acceptance.json"\n    },',
      '      "ref": "contracts/acceptance.json",\n      "\\u0072ef": "contracts/unrelated.json"\n    },',
    );

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "canonical Fourth Wall corpus contains a duplicate JSON object key",
    );
  });

  it("rejects conflicting duplicate acceptance refs in a handoff", async () => {
    const root = await fixture();
    await replaceRaw(
      root,
      TRUST_CORPUS,
      '          "ref": "contracts/acceptance.json",',
      '          "ref": "contracts/acceptance.json",\n          "ref": "contracts/unrelated.json",',
    );

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "canonical Fourth Wall corpus contains a duplicate JSON object key",
    );
  });

  it("rejects nested duplicate keys by decoded Unicode identity", async () => {
    const root = await fixture();
    const escapedVersionKey = ["\\u0076", "ersion"].join("");
    await replaceRaw(
      root,
      TRUST_CORPUS,
      '    "policy": {\n      "version": "policy-2",',
      `    "policy": {\n      "version": "policy-2",\n      "${escapedVersionKey}": "conflict",`,
    );

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "canonical Fourth Wall corpus contains a duplicate JSON object key",
    );
  });
});
