import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseActionlintFindings,
  runActionlintGate,
} from "../../src/repository-security/actionlint/gate.ts";
import { validateWorkflowActionPins } from "../../src/repository-security/workflow/pins.ts";
import { createSecurityFixtureScope } from "./support.ts";

const FULL_COMMIT_PATTERN = /@[a-f0-9]{40}/u;

const CHECKOUT_COMMIT = "34e114876b0b11c390a56381ad16ebd13914f8d5";
const fixtures = createSecurityFixtureScope();

afterEach(fixtures.cleanup);

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
    for (const source of unsupportedActionSources()) {
      await writeFile(workflow, source, { mode: 0o600 });
      await expect(validateWorkflowActionPins([workflow])).rejects.toThrow();
    }
  });

  it("rejects hidden action syntax at the aggregate action gate", async () => {
    const root = await temporaryRoot();
    const workflows = join(root, ".github", "workflows");
    const probes = join(root, "probes");
    await Promise.all([
      mkdir(workflows, { recursive: true, mode: 0o700 }),
      mkdir(probes, { mode: 0o700 }),
    ]);
    const workflow = join(workflows, "ci.yml");
    for (const source of unsupportedActionSources()) {
      await writeFile(workflow, source, { mode: 0o600 });
      await expect(
        runActionlintGate(
          await fixtures.workspace(),
          root,
          probes,
          "/unused/actionlint",
          "/unused/shellcheck",
        ),
      ).rejects.toThrow();
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
    "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n" +
    "      - run: |\n          printf '%s\\n' 'ordinary block scalar'\n"
  );
}

function unsupportedActionSources(): readonly string[] {
  return [
    flowActionWithBlockDecoy(),
    blockActionWithNestedDecoy(),
    duplicateActionNode(),
    aliasActionWithNestedDecoy(),
    mergeDerivedActions(),
    escapedQuotedAction(),
    taggedActionScalar(),
    continuedQuotedAction(),
    taggedJobsMap(),
    taggedStepMap(),
    rootMergeAction(),
  ];
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

function escapedQuotedAction(): string {
  return validWorkflow().replace(
    `actions/checkout@${CHECKOUT_COMMIT}`,
    `"actions/checkout@\\x33\\x34${CHECKOUT_COMMIT.slice(2)}"`,
  );
}

function taggedActionScalar(): string {
  return validWorkflow().replace(
    `actions/checkout@${CHECKOUT_COMMIT}`,
    `!!str actions/checkout@${CHECKOUT_COMMIT}`,
  );
}

function continuedQuotedAction(): string {
  const split = 20;
  const reference = `actions/checkout@${CHECKOUT_COMMIT}`;
  return validWorkflow().replace(
    reference,
    `"${reference.slice(0, split)}\\\n          ${reference.slice(split)}"`,
  );
}

function taggedJobsMap(): string {
  return validWorkflow().replace("jobs:\n", "jobs: !!map\n");
}

function taggedStepMap(): string {
  return validWorkflow().replace(
    "      - uses: actions/checkout@",
    "      - !!map\n        uses: actions/checkout@",
  );
}

function rootMergeAction(): string {
  return (
    "hidden: &hidden\n" +
    "  jobs:\n" +
    "    hidden:\n" +
    `      uses: actions/checkout@${CHECKOUT_COMMIT} # v4.3.1\n` +
    "<<: *hidden\n" +
    validWorkflow()
  );
}

async function temporaryRoot(): Promise<string> {
  return await fixtures.directory("actions");
}
