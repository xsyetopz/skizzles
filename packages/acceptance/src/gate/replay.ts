import type {
  VerificationGateInput,
  VerificationGateReceipt,
  VerificationGateResult,
  VerificationGateVerifyResult,
} from "../contract.ts";
import { dataRecord } from "../object.ts";
import { inputBindings, parseGateInput } from "./input.ts";
import { bindingDigest } from "./report.ts";

export interface ReplayBinding {
  readonly owner: object;
  readonly input: VerificationGateInput;
}

export interface ReplayRequest {
  readonly owner: object;
  readonly raw: unknown;
  readonly isReceipt: (value: unknown) => value is VerificationGateReceipt;
  readonly bindingFor: (
    receipt: VerificationGateReceipt,
  ) => ReplayBinding | undefined;
  readonly evaluate: (
    input: VerificationGateInput,
  ) => Promise<VerificationGateResult>;
}

export async function verifyEvaluation(
  request: ReplayRequest,
): Promise<VerificationGateVerifyResult> {
  try {
    const record = dataRecord(request.raw, ["receipt", "evaluation"]);
    if (record === undefined || !request.isReceipt(record["receipt"])) {
      return replayRejected();
    }
    const receipt = record["receipt"];
    const input = parseGateInput(record["evaluation"]);
    const binding = request.bindingFor(receipt);
    if (
      input === undefined ||
      binding === undefined ||
      binding.owner !== request.owner ||
      !sameEvaluation(binding.input, input)
    ) {
      return replayRejected();
    }
    const replay = await request.evaluate(input);
    if (
      replay.status !== "accepted" ||
      replay.receipt.receiptDigest !== receipt.receiptDigest ||
      replay.receipt.reviewDigest !== receipt.reviewDigest
    ) {
      return replayRejected();
    }
    return Object.freeze({
      status: "valid" as const,
      receiptDigest: receipt.receiptDigest,
      reviewDigest: receipt.reviewDigest,
    });
  } catch {
    return replayRejected();
  }
}

function replayRejected(): VerificationGateVerifyResult {
  return Object.freeze({
    status: "rejected" as const,
    code: "REPLAY_REJECTED",
  });
}

function sameEvaluation(
  left: VerificationGateInput,
  right: VerificationGateInput,
): boolean {
  return (
    bindingDigest(inputBindings(left)) ===
      bindingDigest(inputBindings(right)) &&
    left.evidence.source === right.evidence.source &&
    left.evidence.changeAssurance === right.evidence.changeAssurance &&
    left.evidence.physical === right.evidence.physical &&
    left.evidence.originalTests === right.evidence.originalTests &&
    left.evidence.taskWorktree.length === right.evidence.taskWorktree.length &&
    left.evidence.taskWorktree.every(
      (receipt, index) => receipt === right.evidence.taskWorktree[index],
    )
  );
}
