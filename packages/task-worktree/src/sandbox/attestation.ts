import {
  digestJson,
  hasOnlyKeys,
  isDensePlainArray,
  isPlainDataRecord,
  isSafeRelativePath,
} from "../policy/value.ts";
import type {
  PortableSandboxNegotiationResult,
  PortableSandboxReceipt,
  SandboxCapabilityAttestation,
  SandboxCapabilityAuthorityConfig,
} from "./contract.ts";

export interface AttestationState {
  readonly authority: SandboxCapabilityAuthorityConfig;
  readonly brokerToken: object;
  readonly attestationDigest: string;
  readonly writePaths: readonly string[];
}

export const attestationStates = new WeakMap<object, AttestationState>();

export function parsePaths(value: unknown): readonly string[] | null {
  if (!isDensePlainArray(value) || value.length === 0) return null;
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const path of value) {
    if (!isSafeRelativePath(path) || seen.has(path)) return null;
    seen.add(path);
    paths.push(path);
  }
  return Object.freeze(
    paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

export function parseAttestation(
  value: unknown,
  expectedPaths: readonly string[],
): SandboxCapabilityAttestation | null {
  if (
    !(
      isPlainDataRecord(value) &&
      hasOnlyKeys(value, [
        "mechanism",
        "writePaths",
        "deniesUndeclaredWrites",
        "deniesSystemControl",
        "readOnlyWorktree",
        "networkDisabled",
        "boundedProcessTree",
        "evidence",
      ]) &&
      ["landlock", "apparmor", "container-user-namespace", "seatbelt"].includes(
        String(value["mechanism"]),
      )
    ) ||
    value["deniesUndeclaredWrites"] !== true ||
    value["deniesSystemControl"] !== true ||
    value["readOnlyWorktree"] !== true ||
    value["networkDisabled"] !== true ||
    value["boundedProcessTree"] !== true ||
    typeof value["evidence"] !== "string" ||
    value["evidence"].length < 8
  )
    return null;
  const paths = parsePaths(value["writePaths"]);
  if (paths === null || JSON.stringify(paths) !== JSON.stringify(expectedPaths))
    return null;
  return Object.freeze({
    mechanism: value["mechanism"] as SandboxCapabilityAttestation["mechanism"],
    writePaths: paths,
    deniesUndeclaredWrites: true,
    deniesSystemControl: true,
    readOnlyWorktree: true,
    networkDisabled: true,
    boundedProcessTree: true,
    evidence: value["evidence"],
  });
}

export function negotiateSandbox(
  authority: SandboxCapabilityAuthorityConfig,
  brokerToken: object,
  pathInput: unknown,
): Promise<PortableSandboxNegotiationResult> {
  return negotiate(authority, brokerToken, pathInput);
}

async function negotiate(
  authority: SandboxCapabilityAuthorityConfig,
  brokerToken: object,
  pathInput: unknown,
): Promise<PortableSandboxNegotiationResult> {
  const paths = parsePaths(pathInput);
  if (paths === null)
    return Object.freeze({
      status: "rejected",
      code: "INVALID_SANDBOX_TARGETS",
    });
  let raw: unknown;
  try {
    raw = await authority.attest(paths);
  } catch {
    return Object.freeze({
      status: "rejected",
      code: "CAPABILITY_UNAVAILABLE",
    });
  }
  const attestation = parseAttestation(raw, paths);
  if (attestation === null)
    return Object.freeze({ status: "rejected", code: "CAPABILITY_MISMATCH" });
  const body = { ...attestation, authorityId: authority.id } as const;
  const receipt: PortableSandboxReceipt = Object.freeze({
    ...body,
    receiptDigest: digestJson(body),
  });
  attestationStates.set(receipt, {
    authority,
    brokerToken,
    attestationDigest: receipt.receiptDigest,
    writePaths: receipt.writePaths,
  });
  return Object.freeze({ status: "accepted", receipt });
}
