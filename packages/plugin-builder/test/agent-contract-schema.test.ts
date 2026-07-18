// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  link,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { readContainedJsonAsset } from "../src/agent-contract/asset-boundary.ts";
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
});

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

describe("agent contract filesystem boundary", () => {
  it("rejects a canonical asset symlink before destination mutation", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    const marker = join(destination, "preserved.txt");
    await Bun.write(marker, "preserved\n");
    await rm(join(root, CONTEXT_SCHEMA));
    await symlink(join(root, HANDOFF_SCHEMA), join(root, CONTEXT_SCHEMA));

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "canonical Fourth Wall schema uses a symlinked path",
    );
    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "is an unsupported symlink",
    );
    expect(await readFile(marker, "utf8")).toBe("preserved\n");
  });

  it("rejects a canonical parent symlink before destination mutation", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    const marker = join(destination, "preserved.txt");
    await Bun.write(marker, "preserved\n");
    const contracts = dirname(join(root, CONTEXT_SCHEMA));
    const realContracts = `${contracts}-real`;
    await rename(contracts, realContracts);
    await symlink(realContracts, contracts);

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "canonical Fourth Wall schema uses a symlinked path",
    );
    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "is an unsupported symlink",
    );
    expect(await readFile(marker, "utf8")).toBe("preserved\n");
  });

  it("rejects a staged symlink to its canonical asset", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    await stagePlugin(root, destination);
    const stagedSchema = join(destination, HANDOFF_SCHEMA);
    await rm(stagedSchema);
    await symlink(join(root, HANDOFF_SCHEMA), stagedSchema);

    await expect(
      validateStagedAgentContracts(root, destination),
    ).rejects.toThrow("staged Fourth Wall schema uses a symlinked path");
  });

  it("rejects a canonical asset hardlink before destination mutation", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    const marker = join(destination, "preserved.txt");
    await Bun.write(marker, "preserved\n");
    await link(
      join(root, CONTEXT_SCHEMA),
      join(root, `${CONTEXT_SCHEMA}.link`),
    );

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "canonical Fourth Wall schema uses a hardlinked file",
    );
    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "must be a contained non-symlink regular file",
    );
    expect(await readFile(marker, "utf8")).toBe("preserved\n");
  });

  it("rejects a staged asset hardlink without mutating the stage", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    await stagePlugin(root, destination);
    const marker = join(destination, "preserved.txt");
    await Bun.write(marker, "preserved\n");
    await link(
      join(destination, ACCEPTANCE_CORPUS),
      join(destination, `${ACCEPTANCE_CORPUS}.link`),
    );

    await expect(
      validateStagedAgentContracts(root, destination),
    ).rejects.toThrow(
      "staged Completion Contract corpus uses a hardlinked file",
    );
    expect(await readFile(marker, "utf8")).toBe("preserved\n");
  });

  it("rejects byte drift after safe staged reads", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    await stagePlugin(root, destination);
    const stagedCorpus = join(destination, TRUST_CORPUS);
    await writeFile(stagedCorpus, `${await readFile(stagedCorpus, "utf8")}\n`);

    await expect(
      validateStagedAgentContracts(root, destination),
    ).rejects.toThrow("diverges from its canonical owner");
  });

  it("redacts missing-file paths and operating-system errors", async () => {
    const root = await fixture();
    await rm(join(root, HANDOFF_SCHEMA));

    const message = await rejectionMessage(
      validateCanonicalAgentContracts(root),
    );
    expect(message).toBe(
      "canonical Fourth Wall schema is missing or inaccessible.",
    );
    expect(message).not.toContain(root);
    expect(message).not.toContain("ENOENT");
  });

  it("rejects an ancestor replacement race after identity-bound open", async () => {
    const root = await fixture();
    const contracts = dirname(join(root, CONTEXT_SCHEMA));
    const displaced = `${contracts}-displaced`;

    await expect(
      readContainedJsonAsset(root, CONTEXT_SCHEMA, "race asset", async () => {
        await rename(contracts, displaced);
        await mkdir(contracts, { recursive: true });
      }),
    ).rejects.toThrow("race asset ancestor identity changed during validation");
  });

  it("rejects transient link-write-unlink mutation of the opened inode", async () => {
    const root = await fixture();
    const target = join(root, CONTEXT_SCHEMA);
    const alias = `${target}.transient-link`;
    const message = await rejectionMessage(
      readContainedJsonAsset(
        root,
        CONTEXT_SCHEMA,
        "transient asset",
        async () => {
          await link(target, alias);
          await writeFile(alias, '{"changed":true}\n');
          await rm(alias);
        },
      ).then(() => undefined),
    );
    expect(message).toBe("transient asset changed during identity-bound read.");
    expect(message).not.toContain(root);
  });

  it("rejects an in-place rewrite between bounded descriptor reads", async () => {
    const root = await fixture();
    const target = join(root, HANDOFF_SCHEMA);
    const message = await rejectionMessage(
      readContainedJsonAsset(
        root,
        HANDOFF_SCHEMA,
        "rewritten asset",
        undefined,
        async () => {
          await writeFile(target, '{"changed":true}\n');
        },
      ).then(() => undefined),
    );
    expect(message).toBe("rewritten asset changed during identity-bound read.");
    expect(message).not.toContain(root);
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

async function rejectionMessage(operation: Promise<void>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject.");
}
