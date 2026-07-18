// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateCanonicalAgentContracts,
  validateStagedAgentContracts,
} from "../src/agent-contract/validation.ts";
import { stagePlugin } from "../src/plugin-package.ts";
import {
  createTestWorkspace,
  requiredTestArray,
  requiredTestRecord,
} from "./plugin-package-fixture.ts";

const CONTEXT_SCHEMA =
  "skills/fourth-wall/contracts/context-envelope.schema.json";
const HANDOFF_SCHEMA =
  "skills/fourth-wall/contracts/handoff-review.schema.json";
const TRUST_CORPUS =
  "skills/fourth-wall/fixtures/trust-boundary-incidents.json";
const ACCEPTANCE_SCHEMA =
  "skills/completion-contract/contracts/acceptance.schema.json";
const ACCEPTANCE_CORPUS =
  "skills/completion-contract/fixtures/acceptance-incidents.json";

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("agent trust and evaluation composition", () => {
  it("accepts the canonical versioned schemas and incident corpora", async () => {
    const root = await fixture();

    await expect(
      validateCanonicalAgentContracts(root),
    ).resolves.toBeUndefined();
  });

  it("validates canonical contracts before mutating the stage destination", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    const marker = join(destination, "preserved.txt");
    await Bun.write(marker, "preserved\n");
    await writeFile(join(root, CONTEXT_SCHEMA), "not JSON\n");

    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "context-envelope.schema.json is not valid JSON",
    );
    expect(await readFile(marker, "utf8")).toBe("preserved\n");
  });

  it("rejects unknown schema keywords", async () => {
    const root = await fixture();
    await mutateJson(root, CONTEXT_SCHEMA, (schema) => {
      schema["unknownKeyword"] = true;
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "contains unknown schema keyword unknownKeyword",
    );
  });

  it("rejects malformed schema structure", async () => {
    const root = await fixture();
    await mutateJson(root, HANDOFF_SCHEMA, (schema) => {
      schema["required"] = "objective";
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      ".required must be an array",
    );
  });

  it("rejects unknown corpus fields", async () => {
    const root = await fixture();
    await mutateJson(root, TRUST_CORPUS, (corpus) => {
      corpus["explanation"] = "not part of the versioned corpus";
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "must contain exactly cases, corpusVersion, schemaVersion",
    );
  });

  it("rejects malformed corpus case fields", async () => {
    const root = await fixture();
    await mutateJson(root, ACCEPTANCE_CORPUS, (corpus) => {
      const first = corpusCase(corpus, 0);
      first["category"] = 42;
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      ".category must be a string",
    );
  });

  it("rejects altered corpus input hashes", async () => {
    const root = await fixture();
    await mutateJson(root, TRUST_CORPUS, (corpus) => {
      corpusCase(corpus, 0)["inputSha256"] = "0".repeat(64);
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "inputSha256 does not bind the canonical input",
    );
  });

  it("rejects altered SHA-256 schema constraints", async () => {
    const root = await fixture();
    await mutateJson(root, ACCEPTANCE_SCHEMA, (schema) => {
      objectAt(schema, "properties.judge.properties.promptSha256")["pattern"] =
        ".*";
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "has an unsafe contract value",
    );
  });

  it("rejects reordered corpus cases", async () => {
    const root = await fixture();
    await mutateJson(root, TRUST_CORPUS, (corpus) => {
      const cases = requiredTestArray(corpus["cases"], "cases");
      [cases[0], cases[1]] = [cases[1], cases[0]];
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      ".id is out of canonical order",
    );
  });

  it("rejects duplicate corpus cases", async () => {
    const root = await fixture();
    await mutateJson(root, ACCEPTANCE_CORPUS, (corpus) => {
      const cases = requiredTestArray(corpus["cases"], "cases");
      const first = requiredTestRecord(cases[0], "first case");
      cases[1] = { ...first, ordinal: 2 };
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "contains duplicate case CC-001",
    );
  });

  it("rejects stale schema versions", async () => {
    const root = await fixture();
    await mutateJson(root, CONTEXT_SCHEMA, (schema) => {
      objectAt(schema, "properties.schemaVersion")["const"] = "0.9.0";
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "must require schemaVersion 1.0.0",
    );
  });

  it("rejects stale corpus versions", async () => {
    const root = await fixture();
    await mutateJson(root, ACCEPTANCE_CORPUS, (corpus) => {
      corpus["corpusVersion"] = "0.9.0";
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "unexpected or stale corpusVersion",
    );
  });

  it("rejects schemas that permit self-review", async () => {
    const root = await fixture();
    await mutateJson(root, HANDOFF_SCHEMA, (schema) => {
      objectAt(schema, "properties.authors.properties.selfReview")["const"] =
        true;
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "has an unsafe contract value",
    );
  });

  it("rejects acceptance schemas that put a judge before objective gates", async () => {
    const root = await fixture();
    await mutateJson(root, ACCEPTANCE_SCHEMA, (schema) => {
      const order = objectAt(schema, "properties.evaluationOrder");
      order["prefixItems"] = [{ const: "judge" }, { const: "objectiveGates" }];
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "must order objective gates before the optional judge",
    );
  });

  it("rejects context schemas that omit property-scoped objectives", async () => {
    const root = await fixture();
    await mutateJson(root, CONTEXT_SCHEMA, (schema) => {
      const contextProperty = objectAt(schema, "$defs.contextProperty");
      contextProperty["required"] = requiredTestArray(
        contextProperty["required"],
        "required metadata",
      ).filter((member) => member !== "objective");
    });

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "required is missing property-scoped metadata",
    );
  });

  it("rejects staged contract bytes that drift from canonical owners", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    await stagePlugin(root, destination);
    const stagedCorpus = join(destination, ACCEPTANCE_CORPUS);
    await writeFile(stagedCorpus, `${await readFile(stagedCorpus, "utf8")}\n`);

    await expect(
      validateStagedAgentContracts(root, destination),
    ).rejects.toThrow("diverges from its canonical owner");
  });

  it("rejects absent canonical contract assets", async () => {
    const root = await fixture();
    await rm(join(root, HANDOFF_SCHEMA));

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "is missing or unreadable",
    );
  });
});

async function mutateJson(
  root: string,
  relativePath: string,
  mutation: (document: Record<string, unknown>) => void,
): Promise<void> {
  const path = join(root, relativePath);
  const document = requiredTestRecord(
    JSON.parse(await readFile(path, "utf8")),
    relativePath,
  );
  mutation(document);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

function corpusCase(
  corpus: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const cases = requiredTestArray(corpus["cases"], "cases");
  return requiredTestRecord(cases[index], `case ${index}`);
}

function objectAt(
  root: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  let current = root;
  for (const segment of path.split(".")) {
    current = requiredTestRecord(current[segment], path);
  }
  return current;
}
