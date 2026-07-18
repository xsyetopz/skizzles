// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseActionlintFindings } from "../src/repository-security/actionlint-gate.ts";
import { validateWorkflowActionPins } from "../src/repository-security/workflow-action-pins.ts";

const FULL_COMMIT_PATTERN = /@[a-f0-9]{40}/u;
// biome-ignore lint/security/noSecrets: Public upstream action commit pin.
const CHECKOUT_COMMIT = "34e114876b0b11c390a56381ad16ebd13914f8d5";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("repository action validation contracts", () => {
  it("parses actionlint JSON arrays and JSON Lines findings", () => {
    expect(
      parseActionlintFindings(
        '[{"filepath":"ci.yml","line":2,"column":3,"message":"bad","kind":"syntax-check"}]\n',
      ),
    ).toEqual([
      {
        filepath: "ci.yml",
        line: 2,
        column: 3,
        message: "bad",
        kind: "syntax-check",
      },
    ]);
    expect(
      parseActionlintFindings(
        '{"filepath":"ci.yml","line":4,"column":5,"message":"bad line","kind":"expression"}\n',
      ),
    ).toHaveLength(1);
    expect(() => parseActionlintFindings("not-json\n")).toThrow("JSON Lines");
    expect(() =>
      parseActionlintFindings('{"message":"missing fields"}\n'),
    ).toThrow("output contract");
  });

  it("requires reviewed full-commit action pins with version comments", async () => {
    const workflow = join(await temporaryRoot(), "ci.yml");
    const valid = validWorkflow();
    await writeFile(workflow, valid, { mode: 0o600 });
    await expect(
      validateWorkflowActionPins([workflow]),
    ).resolves.toBeUndefined();

    await writeFile(workflow, valid.replace(FULL_COMMIT_PATTERN, "@v4"), {
      mode: 0o600,
    });
    await expect(validateWorkflowActionPins([workflow])).rejects.toThrow(
      `must use ${CHECKOUT_COMMIT} # v4.3.1`,
    );

    const decoy = valid
      .replace(
        `actions/checkout@${CHECKOUT_COMMIT} # v4.3.1`,
        `actions/checkout@${CHECKOUT_COMMIT}`,
      )
      .replace(
        "    steps:\n",
        `    env:\n      DECOY: 'actions/checkout@${CHECKOUT_COMMIT} # v4.3.1'\n    steps:\n`,
      );
    await writeFile(workflow, decoy, { mode: 0o600 });
    await expect(validateWorkflowActionPins([workflow])).rejects.toThrow(
      `must use ${CHECKOUT_COMMIT} # v4.3.1`,
    );
  });

  it("binds action annotations to exact direct scalar nodes", async () => {
    const workflow = join(await temporaryRoot(), "ci.yml");
    const invalidSources = [
      flowActionWithBlockDecoy(),
      blockActionWithNestedDecoy(),
      duplicateActionNode(),
      aliasActionWithNestedDecoy(),
      mergeDerivedActions(),
    ];
    for (const source of invalidSources) {
      await writeFile(workflow, source, { mode: 0o600 });
      await expect(validateWorkflowActionPins([workflow])).rejects.toThrow();
    }
  });
});

function validWorkflow(): string {
  return (
    "jobs:\n" +
    "  check:\n" +
    "    runs-on: ubuntu-latest\n" +
    "    steps:\n" +
    `      - uses: actions/checkout@${CHECKOUT_COMMIT} # v4.3.1\n` +
    "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n"
  );
}

function flowActionWithBlockDecoy(): string {
  return (
    "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n" +
    `      - { uses: actions/checkout@${CHECKOUT_COMMIT} }\n` +
    "      - name: Annotation decoy\n        run: |\n" +
    `          uses: actions/checkout@${CHECKOUT_COMMIT} # v4.3.1\n` +
    "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n"
  );
}

function blockActionWithNestedDecoy(): string {
  return (
    "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n" +
    "      - uses: >-\n" +
    `          actions/checkout@${CHECKOUT_COMMIT}\n` +
    "        env:\n" +
    `          uses: actions/checkout@${CHECKOUT_COMMIT} # v4.3.1\n` +
    "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n"
  );
}

function duplicateActionNode(): string {
  return validWorkflow().replace(
    `      - uses: actions/checkout@${CHECKOUT_COMMIT} # v4.3.1\n`,
    `      - uses: actions/checkout@${CHECKOUT_COMMIT} # v4.3.1\n        uses: actions/checkout@${CHECKOUT_COMMIT} # v4.3.1\n`,
  );
}

function aliasActionWithNestedDecoy(): string {
  return (
    `checkout: &checkout actions/checkout@${CHECKOUT_COMMIT}\n` +
    "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n" +
    "      - uses: *checkout\n        env:\n" +
    `          uses: actions/checkout@${CHECKOUT_COMMIT} # v4.3.1\n` +
    "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n"
  );
}

function mergeDerivedActions(): string {
  return (
    "checkout: &checkout\n" +
    `  uses: actions/checkout@${CHECKOUT_COMMIT} # v4.3.1\n` +
    "setup: &setup\n" +
    "  uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n" +
    "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n" +
    "      - <<: *checkout\n      - <<: *setup\n"
  );
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-security-test-"));
  temporaryRoots.push(root);
  return root;
}
