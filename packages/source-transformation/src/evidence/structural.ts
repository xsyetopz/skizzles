import type { StructuralEvidenceReceipt } from "./structural-contract.ts";

const authenticReceipts = new WeakSet<StructuralEvidenceReceipt>();

export function authenticateStructuralEvidenceReceipt(
  receipt: StructuralEvidenceReceipt,
): StructuralEvidenceReceipt {
  authenticReceipts.add(receipt);
  return receipt;
}

export function isStructuralEvidenceReceipt(
  value: unknown,
): value is StructuralEvidenceReceipt {
  return (
    typeof value === "object" &&
    value !== null &&
    authenticReceipts.has(value as StructuralEvidenceReceipt)
  );
}
