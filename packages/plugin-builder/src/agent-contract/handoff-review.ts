import {
  AgentContractPackageError,
  CONTRACT_SCHEMA_VERSION,
} from "./contract.ts";
import {
  asInstanceEvaluation,
  assertUnique,
  assertVersionedMatch,
  digest,
  type EvaluationOptions,
  instant,
  nonempty,
  reject,
  sha256Json,
} from "./evaluation-contract.ts";
import type { JsonValue } from "./json-value.ts";
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertRecord,
  assertString,
} from "./json-value.ts";

interface IntegrityReference {
  ref: string;
  sha256: string;
}

export function evaluateHandoffReview(
  value: JsonValue,
  options: EvaluationOptions,
): void {
  asInstanceEvaluation(() => {
    const handoff = assertRecord(value, "handoff review");
    assertExactKeys(
      handoff,
      [
        "schemaVersion",
        "createdAt",
        "expiresAt",
        "objective",
        "inputs",
        "artifacts",
        "acceptance",
        "policy",
        "authors",
        "evidence",
      ],
      "handoff review",
    );
    if (handoff["schemaVersion"] !== CONTRACT_SCHEMA_VERSION) {
      reject("SCHEMA_VERSION_MISMATCH", "handoff schema version is stale");
    }
    evaluateChronology(handoff["createdAt"], handoff["expiresAt"], options);
    evaluateObjective(handoff["objective"], options);
    const inputs = parseReferences(handoff["inputs"], "handoff inputs");
    const artifacts = parseReferences(
      handoff["artifacts"],
      "handoff artifacts",
    );
    assertUnique(
      [...inputs, ...artifacts].map((reference) => reference.ref),
      "handoff input and artifact refs",
    );
    evaluateAcceptance(handoff["acceptance"], options);
    evaluatePolicy(handoff["policy"], options);
    evaluateAuthors(handoff["authors"]);
    evaluateEvidence(handoff["evidence"], [...inputs, ...artifacts]);
  });
}

function evaluateChronology(
  createdValue: JsonValue | undefined,
  expiresValue: JsonValue | undefined,
  options: EvaluationOptions,
): void {
  const createdAt = instant(createdValue, "handoff.createdAt");
  const expiresAt = instant(expiresValue, "handoff.expiresAt");
  if (createdAt > options.now || expiresAt <= createdAt) {
    reject("CHRONOLOGY_INVALID", "handoff timestamps are out of order");
  }
  if (expiresAt <= options.now) {
    reject("CONTEXT_EXPIRED", "handoff has expired");
  }
}

function evaluateObjective(
  value: JsonValue | undefined,
  options: EvaluationOptions,
): void {
  const objective = assertRecord(value, "handoff.objective");
  assertExactKeys(
    objective,
    ["id", "version", "digest", "statement"],
    "handoff.objective",
  );
  const id = nonempty(objective["id"], "handoff.objective.id");
  const version = nonempty(objective["version"], "handoff.objective.version");
  const statement = nonempty(
    objective["statement"],
    "handoff.objective.statement",
  );
  const actualDigest = digest(objective["digest"], "handoff.objective.digest");
  const computedDigest = sha256Json({ id, statement, version });
  if (
    id !== options.objective.id ||
    version !== options.objective.version ||
    actualDigest !== options.objective.digest ||
    actualDigest !== computedDigest
  ) {
    reject("OBJECTIVE_MISMATCH", "handoff objective identity does not match");
  }
}

function parseReferences(
  value: JsonValue | undefined,
  label: string,
): IntegrityReference[] {
  const items = assertArray(value, label);
  if (items.length === 0) {
    throw new AgentContractPackageError(`${label} must not be empty.`);
  }
  const references = items.map((item, index) => {
    const record = assertRecord(item, `${label}[${index}]`);
    assertExactKeys(record, ["ref", "sha256"], `${label}[${index}]`);
    return {
      ref: nonempty(record["ref"], `${label}[${index}].ref`),
      sha256: digest(record["sha256"], `${label}[${index}].sha256`),
    };
  });
  assertUnique(
    references.map((reference) => reference.ref),
    label,
  );
  return references;
}

function evaluateAcceptance(
  value: JsonValue | undefined,
  options: EvaluationOptions,
): void {
  const acceptance = assertRecord(value, "handoff.acceptance");
  assertExactKeys(
    acceptance,
    ["ref", "version", "digest"],
    "handoff.acceptance",
  );
  nonempty(acceptance["ref"], "handoff.acceptance.ref");
  assertVersionedMatch(
    {
      version: nonempty(acceptance["version"], "handoff.acceptance.version"),
      digest: digest(acceptance["digest"], "handoff.acceptance.digest"),
    },
    options.acceptance,
    "ACCEPTANCE_MISMATCH",
    "handoff acceptance",
  );
}

function evaluatePolicy(
  value: JsonValue | undefined,
  options: EvaluationOptions,
): void {
  const policy = assertRecord(value, "handoff.policy");
  assertExactKeys(
    policy,
    ["version", "digest", "modelVersion", "modelDigest"],
    "handoff.policy",
  );
  assertVersionedMatch(
    {
      version: nonempty(policy["version"], "handoff.policy.version"),
      digest: digest(policy["digest"], "handoff.policy.digest"),
    },
    options.policy,
    "POLICY_MISMATCH",
    "handoff policy",
  );
  assertVersionedMatch(
    {
      version: nonempty(policy["modelVersion"], "handoff.policy.modelVersion"),
      digest: digest(policy["modelDigest"], "handoff.policy.modelDigest"),
    },
    options.model,
    "MODEL_MISMATCH",
    "handoff model",
  );
}

function evaluateAuthors(value: JsonValue | undefined): void {
  const authors = assertRecord(value, "handoff.authors");
  assertExactKeys(
    authors,
    ["author", "reviewer", "selfReview"],
    "handoff.authors",
  );
  const author = nonempty(authors["author"], "handoff.authors.author");
  const reviewer = nonempty(authors["reviewer"], "handoff.authors.reviewer");
  const selfReview = assertBoolean(
    authors["selfReview"],
    "handoff.authors.selfReview",
  );
  if (selfReview || author === reviewer) {
    reject("SELF_REVIEW", "handoff author and reviewer must be distinct");
  }
}

function evaluateEvidence(
  value: JsonValue | undefined,
  references: readonly IntegrityReference[],
): void {
  const evidence = assertArray(value, "handoff.evidence");
  if (evidence.length === 0) {
    throw new AgentContractPackageError("handoff.evidence must not be empty.");
  }
  const referenceMap = new Map(
    references.map((reference) => [reference.ref, reference.sha256]),
  );
  const refs = evidence.map((item, index) => {
    const entry = assertRecord(item, `handoff.evidence[${index}]`);
    assertExactKeys(
      entry,
      ["ref", "kind", "sha256"],
      `handoff.evidence[${index}]`,
    );
    const ref = nonempty(entry["ref"], `handoff.evidence[${index}].ref`);
    const kind = assertString(entry["kind"], `handoff.evidence[${index}].kind`);
    if (!new Set(["test", "runtime", "inspection", "hash"]).has(kind)) {
      throw new AgentContractPackageError(
        "handoff evidence kind is unsupported.",
      );
    }
    const sha256 = digest(entry["sha256"], `handoff.evidence[${index}].sha256`);
    if (referenceMap.get(ref) !== sha256) {
      reject(
        "REFERENCE_MISSING",
        "handoff evidence is not bound to an input or artifact",
      );
    }
    return ref;
  });
  assertUnique(refs, "handoff evidence refs");
}
