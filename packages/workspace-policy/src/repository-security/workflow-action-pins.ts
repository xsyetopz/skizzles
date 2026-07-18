import { readFile } from "node:fs/promises";

const LINE_PATTERN = /\r?\n/u;
const REQUIRED_ACTION_PINS = {
  "actions/checkout": {
    // biome-ignore lint/security/noSecrets: Public upstream action commit pin.
    commit: "34e114876b0b11c390a56381ad16ebd13914f8d5",
    version: "v4.3.1",
  },
  "oven-sh/setup-bun": {
    // biome-ignore lint/security/noSecrets: Public upstream action commit pin.
    commit: "0c5077e51419868618aeaa5fe8019c62421857d6",
    version: "v2.2.0",
  },
} as const;

interface WorkflowActionReference {
  location: string;
  reference: string;
}

async function validateWorkflowActionPins(
  workflows: readonly string[],
): Promise<void> {
  const counts = new Map<string, number>();
  for (const workflow of workflows) {
    const source = await readFile(workflow, "utf8");
    const references = parseWorkflowActionReferences(source, workflow);
    for (const { location, reference } of references) {
      if (reference.startsWith("./")) {
        continue;
      }
      const separator = reference.lastIndexOf("@");
      if (separator <= 0 || separator === reference.length - 1) {
        throw new Error(
          `${location} action use requires a full commit and readable version comment`,
        );
      }
      const action = reference.slice(0, separator);
      const commit = reference.slice(separator + 1);
      if (!isRequiredAction(action)) {
        throw new Error(
          `${location} action ${action} is not in the reviewed pin set`,
        );
      }
      const expected = REQUIRED_ACTION_PINS[action];
      if (
        commit !== expected.commit ||
        !hasReadableVersionComment(source, reference, expected.version)
      ) {
        throw new Error(
          `${location} ${action} must use ${expected.commit} # ${expected.version}`,
        );
      }
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
  }
  for (const action of Object.keys(REQUIRED_ACTION_PINS)) {
    if (counts.get(action) !== 1) {
      throw new Error(
        `workflow set must use reviewed action ${action} exactly once`,
      );
    }
  }
}

function parseWorkflowActionReferences(
  source: string,
  workflow: string,
): WorkflowActionReference[] {
  let document: unknown;
  try {
    document = Bun.YAML.parse(source);
  } catch (error) {
    throw new Error(`${workflow} could not be parsed for action pins`, {
      cause: error,
    });
  }
  const root = workflowRecord(document, workflow);
  const jobs = workflowRecord(root["jobs"], `${workflow} jobs`);
  const references: WorkflowActionReference[] = [];
  for (const [jobName, jobInput] of Object.entries(jobs)) {
    const job = workflowRecord(jobInput, `${workflow} job ${jobName}`);
    appendActionReference(
      references,
      job["uses"],
      `${workflow} job ${jobName}`,
    );
    const steps = job["steps"];
    if (steps === undefined) {
      continue;
    }
    if (!Array.isArray(steps)) {
      throw new Error(`${workflow} job ${jobName} steps must be an array`);
    }
    for (const [stepIndex, stepInput] of steps.entries()) {
      const step = workflowRecord(
        stepInput,
        `${workflow} job ${jobName} step ${stepIndex + 1}`,
      );
      appendActionReference(
        references,
        step["uses"],
        `${workflow} job ${jobName} step ${stepIndex + 1}`,
      );
    }
  }
  return references;
}

function appendActionReference(
  references: WorkflowActionReference[],
  input: unknown,
  location: string,
): void {
  if (input === undefined) {
    return;
  }
  if (typeof input !== "string" || input === "") {
    throw new Error(`${location} action use must be a non-empty string`);
  }
  references.push({ location, reference: input });
}

function workflowRecord(
  input: unknown,
  label: string,
): Record<string, unknown> {
  if (!isWorkflowRecord(input)) {
    throw new Error(`${label} must be an object for action-pin validation`);
  }
  return input;
}

function isWorkflowRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasReadableVersionComment(
  source: string,
  reference: string,
  version: string,
): boolean {
  return source.split(LINE_PATTERN).some((line) => {
    const trimmed = line.trimEnd();
    return (
      !trimmed.trimStart().startsWith("#") &&
      trimmed.includes(reference) &&
      trimmed.endsWith(`# ${version}`)
    );
  });
}

function isRequiredAction(
  action: string,
): action is keyof typeof REQUIRED_ACTION_PINS {
  return Object.hasOwn(REQUIRED_ACTION_PINS, action);
}

export { validateWorkflowActionPins };
