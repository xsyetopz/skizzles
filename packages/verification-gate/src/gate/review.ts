import { invokeAuthority } from "../authority.ts";
import type {
  VerificationAuthorityRequest,
  VerificationBindings,
  VerificationGateConfig,
} from "../contract.ts";
import { isDigest, type VerificationDigest } from "../digest.ts";
import { dataRecord } from "../object.ts";
import { bindingDigest } from "./report.ts";

export async function authorizeExclusion(
  config: VerificationGateConfig,
  bindings: VerificationBindings,
  outcome: Readonly<{
    mutantId: VerificationDigest;
    evidenceDigest: VerificationDigest;
  }>,
  mutant: unknown,
): Promise<boolean> {
  if (mutant === undefined) return false;
  const authorityRequest: VerificationAuthorityRequest = Object.freeze({
    purpose: "exclusion",
    bindings,
    bindingDigest: bindingDigest(bindings),
    payload: Object.freeze({
      mutant,
      outcomeEvidenceDigest: outcome.evidenceDigest,
    }),
  });
  let raw: unknown;
  try {
    raw = await invokeAuthority(config.exclusions, authorityRequest);
  } catch {
    return false;
  }
  const record = dataRecord(raw, [
    "status",
    "bindingDigest",
    "mutantId",
    "classification",
    "authorizationDigest",
  ]);
  return (
    record !== undefined &&
    record["status"] === "authorized" &&
    record["bindingDigest"] === bindingDigest(bindings) &&
    record["mutantId"] === outcome.mutantId &&
    (record["classification"] === "invalid" ||
      record["classification"] === "equivalent") &&
    isDigest(record["authorizationDigest"])
  );
}

export function parseReviewer(
  raw: unknown,
  bindings: VerificationBindings,
  reviewContextDigest: VerificationDigest,
):
  | Readonly<{
      status: "accepted" | "rejected";
      reviewDigest: VerificationDigest;
    }>
  | undefined {
  const record = dataRecord(raw, [
    "status",
    "bindingDigest",
    "reviewContextDigest",
    "reviewDigest",
  ]);
  if (
    record === undefined ||
    (record["status"] !== "accepted" && record["status"] !== "rejected") ||
    record["bindingDigest"] !== bindingDigest(bindings) ||
    record["reviewContextDigest"] !== reviewContextDigest ||
    !isDigest(record["reviewDigest"])
  ) {
    return;
  }
  return Object.freeze({
    status: record["status"],
    reviewDigest: record["reviewDigest"],
  });
}
