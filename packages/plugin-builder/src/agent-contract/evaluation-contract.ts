import { createHash } from "node:crypto";
import { AgentContractPackageError } from "./contract.ts";
import type { JsonValue } from "./json-value.ts";
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertInteger,
  assertRecord,
  assertString,
  canonicalJson,
} from "./json-value.ts";

export const REJECTION_CODES = [
  "INSTANCE_SHAPE",
  "SCHEMA_VERSION_MISMATCH",
  "CONTEXT_PROPERTY_DUPLICATE",
  "INTEGRITY_MISMATCH",
  "POLICY_MISMATCH",
  "MODEL_MISMATCH",
  "VALIDATOR_MISMATCH",
  "OBJECTIVE_MISMATCH",
  "ACCEPTANCE_MISMATCH",
  "CONTEXT_EXPIRED",
  "CHRONOLOGY_INVALID",
  "SECRET_REDACTION_REQUIRED",
  "LLM_TRANSFORM_UNVALIDATED",
  "SELF_REVIEW",
  "REFERENCE_DUPLICATE",
  "REFERENCE_MISSING",
  "REQUIREMENT_DUPLICATE",
  "GATE_ORDER_INVALID",
  "GATE_REQUIREMENT_UNKNOWN",
  "RETRY_LIMIT_EXCEEDED",
  "OBJECTIVE_GATE_FAILED",
  "GATE_EVIDENCE_MISSING",
  "EVIDENCE_NON_CAUSAL",
  "EVIDENCE_BINDING_INVALID",
  "FAKE_EFFECT",
  "JUDGE_ORDER_INVALID",
  "JUDGE_MISMATCH",
  "VERIFIER_MUTATION",
  "TEST_MUTATION",
  "SOLUTION_LEAKAGE",
  "GRADER_INJECTION",
  "HARD_CODED_ANSWER",
  "DECEPTIVE_COMPLETION",
  "EXIT_ZERO_ONLY",
  "SUCCESS_TOKEN_ONLY",
  "REVIEWER_MISMATCH",
  "RUN_MISMATCH",
  "REPLAY_DETECTED",
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];
export type AgentContractKind =
  | "acceptance"
  | "context-envelope"
  | "handoff-review";

export interface EvaluationOptions {
  now: number;
  policy: VersionedDigest;
  model: VersionedDigest;
  validator: { id: string; version: string };
  objective: { id: string; version: string; digest: string };
  acceptance: VersionedDigest;
  judge: {
    version: string;
    promptSha256: string;
    enabled: boolean;
    ranAfterObjectiveGates: boolean;
    decision: "not-run" | "pass" | "fail";
  };
  review: {
    author: string;
    reviewer: string;
    eligibleReviewers: ReadonlySet<string>;
  };
  run: {
    id: string;
    startedAt: number;
    completedAt: number;
    expiresAt: number;
    priorRunIds: ReadonlySet<string>;
  };
  maxRetries: number;
  expectedArtifacts: ReadonlyMap<
    string,
    { kind: "implementation" | "test-suite" | "verifier"; sha256: string }
  >;
  expectedEffects: ReadonlyMap<
    string,
    { observed: boolean; evidenceId: string; evidenceRef: string }
  >;
  expectedTests: ReadonlyMap<
    string,
    {
      evidenceRef: string;
      artifactRef: string;
      artifactSha256: string;
      resultSha256: string;
      outcome: "fail" | "pass";
    }
  >;
  expectedFindings: readonly { kind: string; ref: string }[];
}

export interface VersionedDigest {
  version: string;
  digest: string;
}

export class ContractRejection extends Error {
  readonly code: RejectionCode;

  constructor(code: RejectionCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export function reject(code: RejectionCode, detail: string): never {
  throw new ContractRejection(code, detail);
}

export function asInstanceEvaluation(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof ContractRejection) {
      throw error;
    }
    if (error instanceof AgentContractPackageError) {
      reject("INSTANCE_SHAPE", error.message);
    }
    throw error;
  }
}

export function parseEvaluationOptions(value: JsonValue): EvaluationOptions {
  const options = assertRecord(value, "evaluation options");
  assertExactKeys(
    options,
    [
      "now",
      "policy",
      "model",
      "validator",
      "objective",
      "acceptance",
      "judge",
      "review",
      "run",
      "maxRetries",
      "expectedArtifacts",
      "expectedEffects",
      "expectedTests",
      "expectedFindings",
    ],
    "evaluation options",
  );
  const artifactEntries = assertArray(
    options["expectedArtifacts"],
    "evaluation options.expectedArtifacts",
  ).map((item, index) => {
    const entry = assertRecord(
      item,
      `evaluation options.expectedArtifacts[${index}]`,
    );
    assertExactKeys(
      entry,
      ["ref", "kind", "sha256"],
      `evaluation options.expectedArtifacts[${index}]`,
    );
    return {
      ref: nonempty(entry["ref"], "expected artifact ref"),
      kind: artifactKind(entry["kind"]),
      sha256: digest(entry["sha256"], "expected artifact digest"),
    };
  });
  const expectedArtifacts = uniqueMap(
    artifactEntries,
    "expected artifact refs",
  );
  const expectedEffects = uniqueEffectMap(
    assertArray(
      options["expectedEffects"],
      "evaluation options.expectedEffects",
    ).map((item, index) => {
      const label = `evaluation options.expectedEffects[${index}]`;
      const entry = assertRecord(item, label);
      assertExactKeys(
        entry,
        ["id", "observed", "evidenceId", "evidenceRef"],
        label,
      );
      return {
        id: nonempty(entry["id"], `${label}.id`),
        observed: assertBoolean(entry["observed"], `${label}.observed`),
        evidenceId: nonempty(entry["evidenceId"], `${label}.evidenceId`),
        evidenceRef: nonempty(entry["evidenceRef"], `${label}.evidenceRef`),
      };
    }),
  );
  const expectedTests = parseExpectedTests(options["expectedTests"]);
  const expectedFindings = parseExpectedFindings(options["expectedFindings"]);
  const maxRetries = assertInteger(
    options["maxRetries"],
    "evaluation options.maxRetries",
  );
  if (maxRetries < 0 || maxRetries > 3) {
    reject("INSTANCE_SHAPE", "evaluation maxRetries must be between 0 and 3");
  }
  return {
    now: instant(options["now"], "evaluation options.now"),
    policy: versionedDigest(options["policy"], "evaluation options.policy"),
    model: versionedDigest(options["model"], "evaluation options.model"),
    validator: identityVersion(
      options["validator"],
      "evaluation options.validator",
    ),
    objective: objectiveIdentity(
      options["objective"],
      "evaluation options.objective",
    ),
    acceptance: versionedDigest(
      options["acceptance"],
      "evaluation options.acceptance",
    ),
    judge: judgeIdentity(options["judge"]),
    review: reviewIdentity(options["review"]),
    run: runIdentity(options["run"]),
    maxRetries,
    expectedArtifacts,
    expectedEffects,
    expectedTests,
    expectedFindings,
  };
}

export function versionedDigest(
  value: JsonValue | undefined,
  label: string,
): VersionedDigest {
  const record = assertRecord(value, label);
  assertExactKeys(record, ["version", "digest"], label);
  return {
    version: nonempty(record["version"], `${label}.version`),
    digest: digest(record["digest"], `${label}.digest`),
  };
}

export function identityVersion(
  value: JsonValue | undefined,
  label: string,
): { id: string; version: string } {
  const record = assertRecord(value, label);
  assertExactKeys(record, ["id", "version"], label);
  return {
    id: nonempty(record["id"], `${label}.id`),
    version: nonempty(record["version"], `${label}.version`),
  };
}

export function objectiveIdentity(
  value: JsonValue | undefined,
  label: string,
): { id: string; version: string; digest: string } {
  const record = assertRecord(value, label);
  assertExactKeys(record, ["id", "version", "digest"], label);
  return {
    id: nonempty(record["id"], `${label}.id`),
    version: nonempty(record["version"], `${label}.version`),
    digest: digest(record["digest"], `${label}.digest`),
  };
}

export function nonempty(value: JsonValue | undefined, label: string): string {
  const text = assertString(value, label);
  if (text.length === 0) {
    throw new AgentContractPackageError(`${label} must not be empty.`);
  }
  return text;
}

export function digest(value: JsonValue | undefined, label: string): string {
  const text = assertString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(text)) {
    throw new AgentContractPackageError(`${label} must be a SHA-256 digest.`);
  }
  return text;
}

export function instant(value: JsonValue | undefined, label: string): number {
  const text = assertString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(text)) {
    throw new AgentContractPackageError(
      `${label} must be an RFC 3339 UTC instant.`,
    );
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new AgentContractPackageError(`${label} must be a valid instant.`);
  }
  const canonical = new Date(parsed).toISOString();
  const expected = text.includes(".") ? text : text.replace(/Z$/u, ".000Z");
  if (canonical !== expected) {
    throw new AgentContractPackageError(
      `${label} must be a real canonical calendar instant.`,
    );
  }
  return parsed;
}

export function sha256Json(value: JsonValue): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function assertVersionedMatch(
  actual: VersionedDigest,
  expected: VersionedDigest,
  code: RejectionCode,
  label: string,
): void {
  if (
    actual.version !== expected.version ||
    actual.digest !== expected.digest
  ) {
    reject(code, `${label} version or digest does not match`);
  }
}

export function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    reject("REFERENCE_DUPLICATE", `${label} must be unique`);
  }
}

function judgeIdentity(value: JsonValue | undefined): {
  version: string;
  promptSha256: string;
  enabled: boolean;
  ranAfterObjectiveGates: boolean;
  decision: "not-run" | "pass" | "fail";
} {
  const record = assertRecord(value, "evaluation options.judge");
  assertExactKeys(
    record,
    [
      "version",
      "promptSha256",
      "enabled",
      "ranAfterObjectiveGates",
      "decision",
    ],
    "evaluation options.judge",
  );
  const decision = assertString(record["decision"], "judge decision");
  if (decision !== "not-run" && decision !== "pass" && decision !== "fail") {
    throw new AgentContractPackageError("judge decision is unsupported.");
  }
  return {
    version: nonempty(record["version"], "judge version"),
    promptSha256: digest(record["promptSha256"], "judge prompt digest"),
    enabled: assertBoolean(record["enabled"], "judge enabled"),
    ranAfterObjectiveGates: assertBoolean(
      record["ranAfterObjectiveGates"],
      "judge ordering",
    ),
    decision,
  };
}

function reviewIdentity(
  value: JsonValue | undefined,
): EvaluationOptions["review"] {
  const record = assertRecord(value, "evaluation options.review");
  assertExactKeys(
    record,
    ["author", "reviewer", "eligibleReviewers"],
    "evaluation options.review",
  );
  const reviewers = assertArray(
    record["eligibleReviewers"],
    "evaluation options.review.eligibleReviewers",
  ).map((item, index) =>
    nonempty(item, `evaluation options.review.eligibleReviewers[${index}]`),
  );
  assertUnique(reviewers, "eligible reviewer identities");
  return {
    author: nonempty(record["author"], "expected author"),
    reviewer: nonempty(record["reviewer"], "expected reviewer"),
    eligibleReviewers: new Set(reviewers),
  };
}

function runIdentity(value: JsonValue | undefined): EvaluationOptions["run"] {
  const record = assertRecord(value, "evaluation options.run");
  assertExactKeys(
    record,
    ["id", "startedAt", "completedAt", "expiresAt", "priorRunIds"],
    "evaluation options.run",
  );
  const priorRunIds = assertArray(
    record["priorRunIds"],
    "evaluation options.run.priorRunIds",
  ).map((item, index) =>
    nonempty(item, `evaluation options.run.priorRunIds[${index}]`),
  );
  assertUnique(priorRunIds, "prior run ids");
  return {
    id: nonempty(record["id"], "expected run id"),
    startedAt: instant(record["startedAt"], "expected run start"),
    completedAt: instant(record["completedAt"], "expected run completion"),
    expiresAt: instant(record["expiresAt"], "expected run expiry"),
    priorRunIds: new Set(priorRunIds),
  };
}

function uniqueMap(
  values: readonly {
    ref: string;
    kind: "implementation" | "test-suite" | "verifier";
    sha256: string;
  }[],
  label: string,
): EvaluationOptions["expectedArtifacts"] {
  const result = new Map<
    string,
    { kind: "implementation" | "test-suite" | "verifier"; sha256: string }
  >();
  for (const value of values) {
    if (result.has(value.ref)) {
      reject("REFERENCE_DUPLICATE", `${label} must be unique`);
    }
    result.set(value.ref, { kind: value.kind, sha256: value.sha256 });
  }
  return result;
}

function uniqueEffectMap(
  values: readonly {
    id: string;
    observed: boolean;
    evidenceId: string;
    evidenceRef: string;
  }[],
): EvaluationOptions["expectedEffects"] {
  const result = new Map<
    string,
    { observed: boolean; evidenceId: string; evidenceRef: string }
  >();
  for (const value of values) {
    if (result.has(value.id)) {
      reject("REFERENCE_DUPLICATE", "expected effect ids must be unique");
    }
    result.set(value.id, {
      observed: value.observed,
      evidenceId: value.evidenceId,
      evidenceRef: value.evidenceRef,
    });
  }
  return result;
}

function parseExpectedTests(
  value: JsonValue | undefined,
): EvaluationOptions["expectedTests"] {
  const result = new Map<
    string,
    {
      evidenceRef: string;
      artifactRef: string;
      artifactSha256: string;
      resultSha256: string;
      outcome: "fail" | "pass";
    }
  >();
  for (const [index, item] of assertArray(
    value,
    "evaluation options.expectedTests",
  ).entries()) {
    const label = `evaluation options.expectedTests[${index}]`;
    const record = assertRecord(item, label);
    assertExactKeys(
      record,
      [
        "evidenceId",
        "evidenceRef",
        "artifactRef",
        "artifactSha256",
        "resultSha256",
        "outcome",
      ],
      label,
    );
    const evidenceId = nonempty(record["evidenceId"], `${label}.evidenceId`);
    if (result.has(evidenceId)) {
      reject(
        "REFERENCE_DUPLICATE",
        "expected test evidence ids must be unique",
      );
    }
    const outcome = assertString(record["outcome"], `${label}.outcome`);
    if (outcome !== "pass" && outcome !== "fail") {
      throw new AgentContractPackageError(`${label}.outcome is unsupported.`);
    }
    result.set(evidenceId, {
      evidenceRef: nonempty(record["evidenceRef"], `${label}.evidenceRef`),
      artifactRef: nonempty(record["artifactRef"], `${label}.artifactRef`),
      artifactSha256: digest(
        record["artifactSha256"],
        `${label}.artifactSha256`,
      ),
      resultSha256: digest(record["resultSha256"], `${label}.resultSha256`),
      outcome,
    });
  }
  return result;
}

function parseExpectedFindings(
  value: JsonValue | undefined,
): EvaluationOptions["expectedFindings"] {
  const findings = assertArray(
    value,
    "evaluation options.expectedFindings",
  ).map((item, index) => {
    const label = `evaluation options.expectedFindings[${index}]`;
    const record = assertRecord(item, label);
    assertExactKeys(record, ["kind", "ref"], label);
    return {
      kind: nonempty(record["kind"], `${label}.kind`),
      ref: nonempty(record["ref"], `${label}.ref`),
    };
  });
  assertUnique(
    findings.map((finding) => `${finding.kind}\u0000${finding.ref}`),
    "expected findings",
  );
  return findings;
}

function artifactKind(
  value: JsonValue | undefined,
): "implementation" | "test-suite" | "verifier" {
  const kind = assertString(value, "expected artifact kind");
  if (
    kind !== "implementation" &&
    kind !== "test-suite" &&
    kind !== "verifier"
  ) {
    throw new AgentContractPackageError(
      "expected artifact kind is unsupported.",
    );
  }
  return kind;
}
