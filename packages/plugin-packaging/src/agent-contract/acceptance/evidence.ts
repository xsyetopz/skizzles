import { AgentContractPackageError } from "../contract.ts";
import {
  assertUnique,
  digest,
  type EvaluationOptions,
  nonempty,
  reject,
} from "../evaluation/contract.ts";
import type { JsonValue } from "../json/value.ts";
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertRecord,
  assertString,
} from "../json/value.ts";

export type EvidenceKind =
  | "artifact-hash"
  | "inspection"
  | "process-exit"
  | "runtime-effect"
  | "success-token"
  | "test-result";

export interface AcceptanceArtifact {
  ref: string;
  kind: "implementation" | "test-suite" | "verifier";
  sha256: string;
}

export interface AcceptanceEvidence {
  id: string;
  kind: EvidenceKind;
  ref: string;
  artifactRef: string | null;
  effectRef: string | null;
  sha256: string | null;
  outcome: "fail" | "missing" | "observed" | "pass";
}

export type CausalEvidenceKind = "runtime-effect" | "test-result";

interface AcceptanceEffect {
  id: string;
  claimed: boolean;
  observed: boolean;
  evidenceRef: string;
}

export function parseAcceptanceEvidence(
  artifactValue: JsonValue | undefined,
  evidenceValue: JsonValue | undefined,
  effectValue: JsonValue | undefined,
  options: EvaluationOptions,
): {
  artifacts: ReadonlyMap<string, AcceptanceArtifact>;
  evidence: ReadonlyMap<string, AcceptanceEvidence>;
} {
  const artifacts = parseArtifacts(artifactValue, options);
  const evidence = parseEvidence(evidenceValue);
  const effects = parseEffects(effectValue, options);
  validateEvidenceBindings(artifacts, evidence, effects, options);
  return { artifacts, evidence };
}

export function requireCausalGateEvidence(
  evidenceRefs: readonly string[],
  evidence: ReadonlyMap<string, AcceptanceEvidence>,
  gateLabel: string,
  requiredKind: CausalEvidenceKind,
): void {
  const records = evidenceRefs.map((ref) => {
    const record = evidence.get(ref);
    if (record === undefined) {
      reject("REFERENCE_MISSING", `${gateLabel} references unknown evidence`);
    }
    return record;
  });
  if (
    records.some(
      (record) => record.outcome === "fail" || record.outcome === "missing",
    )
  ) {
    reject("OBJECTIVE_GATE_FAILED", `${gateLabel} evidence did not pass`);
  }
  if (records.some((record) => record.kind === requiredKind)) {
    return;
  }
  if (records.every((record) => record.kind === "process-exit")) {
    reject("EXIT_ZERO_ONLY", `${gateLabel} relies only on process exit status`);
  }
  if (records.every((record) => record.kind === "success-token")) {
    reject("SUCCESS_TOKEN_ONLY", `${gateLabel} relies only on a success token`);
  }
  reject("EVIDENCE_NON_CAUSAL", `${gateLabel} lacks causal evidence`);
}

function parseArtifacts(
  value: JsonValue | undefined,
  options: EvaluationOptions,
): ReadonlyMap<string, AcceptanceArtifact> {
  const items = assertArray(value, "acceptance.artifacts");
  if (items.length === 0) {
    throw new AgentContractPackageError(
      "acceptance.artifacts must not be empty.",
    );
  }
  const artifacts = items.map((item, index) => {
    const artifact = assertRecord(item, `acceptance.artifacts[${index}]`);
    assertExactKeys(
      artifact,
      ["ref", "kind", "sha256"],
      `acceptance.artifacts[${index}]`,
    );
    const kind = parseArtifactKind(
      artifact["kind"],
      `acceptance.artifacts[${index}].kind`,
    );
    return {
      ref: nonempty(artifact["ref"], `acceptance.artifacts[${index}].ref`),
      kind,
      sha256: digest(
        artifact["sha256"],
        `acceptance.artifacts[${index}].sha256`,
      ),
    };
  });
  assertUnique(
    artifacts.map((artifact) => artifact.ref),
    "acceptance artifact refs",
  );
  const artifactMap = new Map(
    artifacts.map((artifact) => [artifact.ref, artifact] as const),
  );
  for (const [ref, expected] of options.expectedArtifacts) {
    const artifact = artifactMap.get(ref);
    if (artifact === undefined) {
      reject("REFERENCE_MISSING", "expected acceptance artifact is absent");
    }
    if (
      artifact.sha256 !== expected.sha256 ||
      artifact.kind !== expected.kind
    ) {
      if (expected.kind === "verifier") {
        reject("VERIFIER_MUTATION", "verifier artifact digest changed");
      }
      if (expected.kind === "test-suite") {
        reject("TEST_MUTATION", "test-suite artifact digest changed");
      }
      reject("INTEGRITY_MISMATCH", "acceptance artifact digest changed");
    }
  }
  return artifactMap;
}

function parseArtifactKind(
  value: JsonValue | undefined,
  label: string,
): AcceptanceArtifact["kind"] {
  const kind = assertString(value, label);
  if (
    kind !== "implementation" &&
    kind !== "verifier" &&
    kind !== "test-suite"
  ) {
    throw new AgentContractPackageError(
      "acceptance artifact kind is unsupported.",
    );
  }
  return kind;
}

function parseEvidence(
  value: JsonValue | undefined,
): ReadonlyMap<string, AcceptanceEvidence> {
  const items = assertArray(value, "acceptance.evidence");
  if (items.length === 0) {
    throw new AgentContractPackageError(
      "acceptance.evidence must not be empty.",
    );
  }
  const evidence = items.map((item, index) => {
    const label = `acceptance.evidence[${index}]`;
    const record = assertRecord(item, label);
    assertExactKeys(
      record,
      ["id", "kind", "ref", "artifactRef", "effectRef", "sha256", "outcome"],
      label,
    );
    const kind = parseEvidenceKind(record["kind"], `${label}.kind`);
    const outcome = parseOutcome(record["outcome"], `${label}.outcome`);
    return {
      id: nonempty(record["id"], `${label}.id`),
      kind,
      ref: nonempty(record["ref"], `${label}.ref`),
      artifactRef: nullableString(
        record["artifactRef"],
        `${label}.artifactRef`,
      ),
      effectRef: nullableString(record["effectRef"], `${label}.effectRef`),
      sha256: nullableDigest(record["sha256"], `${label}.sha256`),
      outcome,
    };
  });
  assertUnique(
    evidence.map((entry) => entry.id),
    "acceptance evidence ids",
  );
  return new Map(evidence.map((entry) => [entry.id, entry] as const));
}

function parseEffects(
  value: JsonValue | undefined,
  options: EvaluationOptions,
): ReadonlyMap<string, AcceptanceEffect> {
  const items = assertArray(value, "acceptance.effects");
  const effects = items.map((item, index) => {
    const label = `acceptance.effects[${index}]`;
    const effect = assertRecord(item, label);
    assertExactKeys(
      effect,
      ["id", "claimed", "observed", "evidenceRef"],
      label,
    );
    const parsed = {
      id: nonempty(effect["id"], `${label}.id`),
      claimed: assertBoolean(effect["claimed"], `${label}.claimed`),
      observed: assertBoolean(effect["observed"], `${label}.observed`),
      evidenceRef: nonempty(effect["evidenceRef"], `${label}.evidenceRef`),
    };
    const expected = options.expectedEffects.get(parsed.id);
    if (
      expected === undefined ||
      !parsed.claimed ||
      !parsed.observed ||
      !expected.observed ||
      parsed.evidenceRef !== expected.evidenceId
    ) {
      reject("FAKE_EFFECT", "runtime effect does not match trusted facts");
    }
    return parsed;
  });
  assertUnique(
    effects.map((effect) => effect.id),
    "acceptance effect ids",
  );
  const result = new Map(effects.map((effect) => [effect.id, effect] as const));
  for (const id of options.expectedEffects.keys()) {
    if (!result.has(id)) {
      reject("REFERENCE_MISSING", "trusted runtime effect is absent");
    }
  }
  return result;
}

function validateEvidenceBindings(
  artifacts: ReadonlyMap<string, AcceptanceArtifact>,
  evidence: ReadonlyMap<string, AcceptanceEvidence>,
  effects: ReadonlyMap<string, AcceptanceEffect>,
  options: EvaluationOptions,
): void {
  for (const record of evidence.values()) {
    if (record.kind === "artifact-hash") {
      const artifact =
        record.artifactRef === null
          ? undefined
          : artifacts.get(record.artifactRef);
      if (
        artifact === undefined ||
        record.effectRef !== null ||
        record.sha256 !== artifact.sha256 ||
        record.outcome !== "pass"
      ) {
        reject(
          "EVIDENCE_BINDING_INVALID",
          "artifact evidence is not integrity-bound",
        );
      }
      continue;
    }
    if (record.kind === "test-result") {
      const expected = options.expectedTests.get(record.id);
      const artifact =
        record.artifactRef === null
          ? undefined
          : artifacts.get(record.artifactRef);
      if (
        expected === undefined ||
        artifact === undefined ||
        artifact.kind !== "test-suite" ||
        record.ref !== expected.evidenceRef ||
        record.artifactRef !== expected.artifactRef ||
        artifact.sha256 !== expected.artifactSha256 ||
        record.sha256 !== expected.resultSha256 ||
        record.outcome !== expected.outcome ||
        record.effectRef !== null
      ) {
        reject(
          "EVIDENCE_BINDING_INVALID",
          "test result does not match trusted suite and result facts",
        );
      }
      continue;
    }
    if (record.kind === "runtime-effect") {
      const effect =
        record.effectRef === null ? undefined : effects.get(record.effectRef);
      const expected =
        record.effectRef === null
          ? undefined
          : options.expectedEffects.get(record.effectRef);
      if (
        effect === undefined ||
        expected === undefined ||
        record.id !== expected.evidenceId ||
        record.ref !== expected.evidenceRef ||
        record.artifactRef !== null ||
        record.sha256 !== null ||
        record.outcome !== "observed" ||
        !expected.observed ||
        !effect.observed ||
        effect.evidenceRef !== record.id
      ) {
        reject(
          "EVIDENCE_BINDING_INVALID",
          "runtime evidence is not effect-bound",
        );
      }
      continue;
    }
    if (
      record.artifactRef !== null ||
      record.effectRef !== null ||
      record.sha256 !== null
    ) {
      reject(
        "EVIDENCE_BINDING_INVALID",
        "non-causal evidence claims a causal binding",
      );
    }
  }
  for (const effect of effects.values()) {
    const record = evidence.get(effect.evidenceRef);
    if (
      record === undefined ||
      record.kind !== "runtime-effect" ||
      record.effectRef !== effect.id
    ) {
      reject(
        "EVIDENCE_BINDING_INVALID",
        "effect lacks matching runtime evidence",
      );
    }
  }
  for (const id of options.expectedTests.keys()) {
    const record = evidence.get(id);
    if (record === undefined || record.kind !== "test-result") {
      reject("REFERENCE_MISSING", "trusted test result is absent");
    }
  }
}

function parseEvidenceKind(
  value: JsonValue | undefined,
  label: string,
): EvidenceKind {
  const kind = assertString(value, label);
  if (
    kind !== "test-result" &&
    kind !== "runtime-effect" &&
    kind !== "artifact-hash" &&
    kind !== "inspection" &&
    kind !== "process-exit" &&
    kind !== "success-token"
  ) {
    throw new AgentContractPackageError(`${label} is unsupported.`);
  }
  return kind;
}

function parseOutcome(
  value: JsonValue | undefined,
  label: string,
): AcceptanceEvidence["outcome"] {
  const outcome = assertString(value, label);
  if (
    outcome !== "pass" &&
    outcome !== "fail" &&
    outcome !== "observed" &&
    outcome !== "missing"
  ) {
    throw new AgentContractPackageError(`${label} is unsupported.`);
  }
  return outcome;
}

function nullableString(
  value: JsonValue | undefined,
  label: string,
): string | null {
  if (value === null) {
    return null;
  }
  return nonempty(value, label);
}

function nullableDigest(
  value: JsonValue | undefined,
  label: string,
): string | null {
  if (value === null) {
    return null;
  }
  return digest(value, label);
}
