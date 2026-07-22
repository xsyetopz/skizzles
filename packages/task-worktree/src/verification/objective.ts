import type { TaskWorktreeDigest } from "../digest.ts";
import { isPlainDataRecord } from "../policy/value.ts";
import type { SandboxVerificationObjective } from "../sandbox/contract.ts";
import { parseSandboxVerificationObjective } from "../sandbox/objective.ts";
import type { TaskWorktreeVerificationObjective } from "./contract.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export function parseTaskWorktreeVerificationObjective(
  value: unknown,
): TaskWorktreeVerificationObjective | undefined {
  if (!isPlainDataRecord(value) || !Object.isFrozen(value)) return;
  if (value["kind"] !== "original-tests")
    return parseSandboxVerificationObjective(value) as
      | TaskWorktreeVerificationObjective
      | undefined;
  if (
    Reflect.ownKeys(value).length !== 3 ||
    !Object.hasOwn(value, "structuralReceiptDigest") ||
    !Object.hasOwn(value, "containerImageDigest")
  )
    return;
  const structuralReceiptDigest = digest(value["structuralReceiptDigest"]);
  const containerImageDigest = digest(value["containerImageDigest"]);
  if (
    structuralReceiptDigest === undefined ||
    containerImageDigest === undefined
  )
    return;
  return Object.freeze({
    kind: "original-tests",
    structuralReceiptDigest,
    containerImageDigest,
  });
}

export function materializeVerificationObjective(
  objective: TaskWorktreeVerificationObjective,
  context: Readonly<{
    baselineTestManifestDigest: TaskWorktreeDigest;
    productionOverlayDigest: TaskWorktreeDigest;
    containerEvidenceDigest: TaskWorktreeDigest;
  }>,
): SandboxVerificationObjective {
  return objective.kind === "original-tests"
    ? Object.freeze({
        ...objective,
        baselineTestManifestDigest: context.baselineTestManifestDigest,
        productionOverlayDigest: context.productionOverlayDigest,
        containerEvidenceDigest: context.containerEvidenceDigest,
      })
    : objective;
}

function digest(value: unknown): TaskWorktreeDigest | undefined {
  return typeof value === "string" && digestPattern.test(value)
    ? (value as TaskWorktreeDigest)
    : undefined;
}
