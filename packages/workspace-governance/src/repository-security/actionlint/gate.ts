import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunWorkspace } from "@skizzles/scratchspace";
import { REPOSITORY_TOOL_ENV, runBoundedCommand } from "../process.ts";
import { validateWorkflowActionPins } from "../workflow/pins.ts";

const ACTIONLINT_JSON_FORMAT = "{{json .}}";
const ACTIONLINT_TIMEOUT_MS = 30_000;
const LINE_PATTERN = /\r?\n/u;
const INVALID_EVENT_PATTERN =
  /unknown Webhook event|unexpected key|invalid event/iu;
const INVALID_EXPRESSION_PATTERN =
  /property .*not defined|undefined|not_a_real_property/iu;
const INVALID_NEEDS_PATTERN = /needs|missing/iu;
const UNQUOTED_SHELL_PATTERN = /SC2086|double quote/iu;

interface ActionlintFinding {
  filepath: string;
  line: number;
  column: number;
  message: string;
  kind: string;
}

async function runActionlintGate(
  runWorkspace: RunWorkspace,
  workspaceRoot: string,
  probeRoot: string,
  actionlint: string,
  shellcheck: string,
): Promise<void> {
  const workflows = await discoverWorkflows(workspaceRoot);
  await validateWorkflowActionPins(workflows);
  const current = await invokeActionlint(
    runWorkspace,
    actionlint,
    shellcheck,
    workflows,
  );
  if (current.exitCode !== 0 || current.findings.length > 0) {
    throw new Error(formatCurrentWorkflowFailure(current.findings));
  }

  const invalidCases = [
    {
      name: "invalid-event.yml",
      source: workflowWithEvent("pussh"),
      expected: INVALID_EVENT_PATTERN,
      label: "invalid event",
    },
    {
      name: "invalid-expression.yml",
      source: workflowWithStep('echo "${{ github.not_a_real_property }}"'),
      expected: INVALID_EXPRESSION_PATTERN,
      label: "invalid expression",
    },
    {
      name: "invalid-needs.yml",
      source: workflowWithInvalidNeeds(),
      expected: INVALID_NEEDS_PATTERN,
      label: "invalid needs dependency",
    },
    {
      name: "unquoted-shell.yml",
      source: workflowWithStep("echo $UNQUOTED"),
      expected: UNQUOTED_SHELL_PATTERN,
      label: "unquoted shell expansion",
    },
  ] as const;

  for (const invalid of invalidCases) {
    const path = join(probeRoot, invalid.name);
    await writeFile(path, invalid.source, { mode: 0o600 });
    const result = await invokeActionlint(
      runWorkspace,
      actionlint,
      shellcheck,
      [path],
    );
    if (
      result.exitCode === 0 ||
      result.findings.length === 0 ||
      !result.findings.some((finding) =>
        invalid.expected.test(JSON.stringify(finding)),
      )
    ) {
      throw new Error(`actionlint did not reject the ${invalid.label} probe`);
    }
  }

  const corrected = join(probeRoot, "corrected.yml");
  await writeFile(corrected, correctedWorkflow(), { mode: 0o600 });
  const correctedResult = await invokeActionlint(
    runWorkspace,
    actionlint,
    shellcheck,
    [corrected],
  );
  if (correctedResult.exitCode !== 0 || correctedResult.findings.length > 0) {
    throw new Error("actionlint rejected the corrected workflow probe");
  }
}

async function discoverWorkflows(workspaceRoot: string): Promise<string[]> {
  const root = join(workspaceRoot, ".github", "workflows");
  const workflows = (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")),
    )
    .map((entry) => join(root, entry.name))
    .sort();
  if (workflows.length === 0) {
    throw new Error("actionlint requires at least one repository workflow");
  }
  return workflows;
}

async function invokeActionlint(
  runWorkspace: RunWorkspace,
  actionlint: string,
  shellcheck: string,
  workflows: readonly string[],
): Promise<{ exitCode: number; findings: ActionlintFinding[] }> {
  const result = await runBoundedCommand(
    runWorkspace,
    actionlint,
    [
      "-no-color",
      `-shellcheck=${shellcheck}`,
      "-format",
      ACTIONLINT_JSON_FORMAT,
      ...workflows,
    ],
    {
      label: "actionlint",
      timeoutMs: ACTIONLINT_TIMEOUT_MS,
      outputLimitBytes: 1_048_576,
      env: REPOSITORY_TOOL_ENV,
    },
  );
  if (result.stderr !== "") {
    throw new Error("actionlint wrote unexpected diagnostic output");
  }
  return {
    exitCode: result.exitCode,
    findings: parseActionlintFindings(result.stdout),
  };
}

function parseActionlintFindings(output: string): ActionlintFinding[] {
  const trimmed = output.trim();
  if (trimmed === "") {
    return [];
  }
  try {
    const document: unknown = JSON.parse(trimmed);
    if (isActionlintFindingArray(document)) {
      return document;
    }
  } catch {
    // Fall through to JSON Lines for compatibility with alternate format templates.
  }

  const findings: ActionlintFinding[] = [];
  for (const line of trimmed.split(LINE_PATTERN).filter(Boolean)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error("actionlint output was not JSON Lines", { cause: error });
    }
    if (!isActionlintFinding(value)) {
      throw new Error(
        "actionlint JSON finding did not match its output contract",
      );
    }
    findings.push(value);
  }
  return findings;
}

function isActionlintFindingArray(
  value: unknown,
): value is ActionlintFinding[] {
  return Array.isArray(value) && value.every(isActionlintFinding);
}

function isActionlintFinding(value: unknown): value is ActionlintFinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (
    "filepath" in value &&
    typeof value.filepath === "string" &&
    "line" in value &&
    typeof value.line === "number" &&
    "column" in value &&
    typeof value.column === "number" &&
    "message" in value &&
    typeof value.message === "string" &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}

function formatCurrentWorkflowFailure(
  findings: readonly ActionlintFinding[],
): string {
  if (findings.length === 0) {
    return "actionlint failed while checking repository workflows";
  }
  return `actionlint rejected repository workflows: ${findings
    .map(
      (finding) =>
        `${finding.filepath}:${finding.line}:${finding.column} ${finding.message}`,
    )
    .join("; ")}`;
}

function workflowWithEvent(event: string): string {
  return `name: Invalid event\non: [${event}]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "checked"\n`;
}

function workflowWithStep(step: string): string {
  return `name: Invalid step\non: workflow_dispatch\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${step}\n`;
}

function workflowWithInvalidNeeds(): string {
  return 'name: Invalid needs\non: workflow_dispatch\njobs:\n  check:\n    needs: missing\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "checked"\n';
}

function correctedWorkflow(): string {
  const expression = "${{ github.ref }}";
  return `name: Corrected\non: workflow_dispatch\njobs:\n  prepare:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "$QUOTED"\n        env:\n          QUOTED: safe\n  check:\n    needs: prepare\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${expression}"\n`;
}

export type { ActionlintFinding };
export { parseActionlintFindings, runActionlintGate };
