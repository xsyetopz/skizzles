// biome-ignore-all lint/correctness/noUnresolvedImports: Biome's resolver does not follow yaml's package exports; yaml is a declared runtime dependency.
import { readFile } from "node:fs/promises";
import {
  isMap,
  isScalar,
  isSeq,
  type Pair,
  type ParsedNode,
  parseDocument,
  Scalar,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

const VERSION_COMMENT_PATTERN = /^\s*(?:#\s*(?<version>\S+)\s*)?$/u;
const CARRIAGE_RETURN_PATTERN = /\r$/u;
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

type ParsedMap = YAMLMap<ParsedNode, ParsedNode | null>;
type ParsedPair = Pair<ParsedNode, ParsedNode | null>;

interface WorkflowActionReference {
  location: string;
  reference: string;
  version: string | undefined;
}

async function validateWorkflowActionPins(
  workflows: readonly string[],
): Promise<void> {
  const counts = new Map<string, number>();
  const sources = await Promise.all(
    workflows.map(async (workflow) => ({
      workflow,
      source: await readFile(workflow, "utf8"),
    })),
  );
  for (const { workflow, source } of sources) {
    const references = parseWorkflowActionReferences(source, workflow);
    for (const { location, reference, version } of references) {
      if (!reference.startsWith("./")) {
        validateExternalReference(location, reference, version, counts);
      }
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

function validateExternalReference(
  location: string,
  reference: string,
  version: string | undefined,
  counts: Map<string, number>,
): void {
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
  if (commit !== expected.commit || version !== expected.version) {
    throw new Error(
      `${location} ${action} must use ${expected.commit} # ${expected.version}`,
    );
  }
  counts.set(action, (counts.get(action) ?? 0) + 1);
}

function parseWorkflowActionReferences(
  source: string,
  workflow: string,
): WorkflowActionReference[] {
  const document = parseDocument(source, {
    keepSourceTokens: true,
    merge: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const issue = document.errors[0] ?? document.warnings[0];
    throw new Error(
      `${workflow} could not be parsed for action pins: ${issue}`,
    );
  }
  const root = blockMap(document.contents, workflow);
  const jobs = blockMap(
    requiredPair(root, "jobs", workflow).value,
    `${workflow} jobs`,
  );
  const references: WorkflowActionReference[] = [];
  for (const jobPair of jobs.items) {
    const jobName = scalarString(jobPair.key, `${workflow} job name`);
    const location = `${workflow} job ${jobName}`;
    const job = blockMap(jobPair.value, location);
    rejectMergePair(job, location);
    appendActionReference(references, pairFor(job, "uses"), source, location);
    const stepsPair = pairFor(job, "steps");
    if (stepsPair !== undefined) {
      const steps = blockSequence(stepsPair.value, `${location} steps`);
      for (const [stepIndex, stepInput] of steps.items.entries()) {
        const stepLocation = `${location} step ${stepIndex + 1}`;
        const step = blockMap(stepInput, stepLocation);
        rejectMergePair(step, stepLocation);
        appendActionReference(
          references,
          pairFor(step, "uses"),
          source,
          stepLocation,
        );
      }
    }
  }
  return references;
}

function appendActionReference(
  references: WorkflowActionReference[],
  pair: ParsedPair | undefined,
  source: string,
  location: string,
): void {
  if (pair === undefined) {
    return;
  }
  const key = stringScalar(pair.key, `${location} action key`);
  const value = stringScalar(pair.value, `${location} action use`);
  if (
    value.anchor !== undefined ||
    (value.type !== Scalar.PLAIN &&
      value.type !== Scalar.QUOTE_DOUBLE &&
      value.type !== Scalar.QUOTE_SINGLE)
  ) {
    throw new Error(
      `${location} action use must be a direct single-line scalar`,
    );
  }
  const version = exactVersionComment(source, key, value, location);
  references.push({ location, reference: value.value, version });
}

function exactVersionComment(
  source: string,
  key: Scalar<string>,
  value: Scalar<string>,
  location: string,
): string | undefined {
  if (
    key.range === undefined ||
    key.range === null ||
    value.range === undefined ||
    value.range === null
  ) {
    throw new Error(`${location} action use has no exact source range`);
  }
  if (lineStart(source, key.range[0]) !== lineStart(source, value.range[0])) {
    throw new Error(
      `${location} action use must be written on one source line`,
    );
  }
  const newline = source.indexOf("\n", value.range[1]);
  let lineEnd = newline;
  if (lineEnd === -1) {
    lineEnd = source.length;
  }
  const suffix = source
    .slice(value.range[1], lineEnd)
    .replace(CARRIAGE_RETURN_PATTERN, "");
  const match = VERSION_COMMENT_PATTERN.exec(suffix);
  if (match === null) {
    throw new Error(
      `${location} action use has an unsupported trailing source annotation`,
    );
  }
  const version = match.groups?.["version"];
  if ((value.comment?.trim() || undefined) !== version) {
    throw new Error(
      `${location} action version is not bound to its exact scalar node`,
    );
  }
  return version;
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

function requiredPair(map: ParsedMap, key: string, label: string): ParsedPair {
  const pair = pairFor(map, key);
  if (pair === undefined) {
    throw new Error(`${label} requires ${key} for action-pin validation`);
  }
  return pair;
}

function pairFor(map: ParsedMap, key: string): ParsedPair | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function rejectMergePair(map: ParsedMap, label: string): void {
  if (pairFor(map, "<<") !== undefined) {
    throw new Error(`${label} action map must not use YAML merge keys`);
  }
}

function blockMap(input: unknown, label: string): ParsedMap {
  if (!isMap<ParsedNode, ParsedNode | null>(input) || input.flow === true) {
    throw new Error(
      `${label} must be a block YAML map for action-pin validation`,
    );
  }
  return input;
}

function blockSequence(input: unknown, label: string): YAMLSeq<ParsedNode> {
  if (!isSeq<ParsedNode>(input) || input.flow === true) {
    throw new Error(`${label} must be a block YAML sequence`);
  }
  return input;
}

function stringScalar(input: unknown, label: string): Scalar<string> {
  if (!isScalar<string>(input) || typeof input.value !== "string") {
    throw new Error(`${label} must be a direct string scalar`);
  }
  return input;
}

function scalarString(input: unknown, label: string): string {
  return stringScalar(input, label).value;
}

function isRequiredAction(
  action: string,
): action is keyof typeof REQUIRED_ACTION_PINS {
  return Object.hasOwn(REQUIRED_ACTION_PINS, action);
}

export { validateWorkflowActionPins };
