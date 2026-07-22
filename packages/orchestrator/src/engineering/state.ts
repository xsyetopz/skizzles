import { digestValue } from "../digest.ts";
import type { TargetBaseline } from "../state/target.ts";
import type { AssuranceEvidence } from "./assurance/evidence.ts";
import type { ContextBindings } from "./context.ts";
import type { ContinuationBindings } from "./continuation.ts";
import type { ParsedDescribeInput } from "./describe-input.ts";
import type { ParsedEngineeringInput } from "./input.ts";
import type { PhysicalIntegrationReceipt } from "./physical.ts";
import {
  type SourceCursor,
  type SourceNextOperation,
  sourceCursorDigest,
} from "./source/adapter.ts";
import type { SourceContextReceipt } from "./source/context.ts";
import type { PreparedBatch } from "./source/evidence.ts";

export interface PreparationContext {
  readonly input: ParsedDescribeInput;
  readonly receipt: SourceContextReceipt;
  readonly receiptReference: object;
}

export interface CursorState {
  readonly cursor: SourceCursor;
  readonly reference: object;
  readonly next: SourceNextOperation;
}

export interface PreparationState {
  readonly input: ParsedEngineeringInput;
  readonly context: PreparationContext;
  readonly baseline: TargetBaseline;
  readonly phase:
    | "source-start"
    | "source-advance"
    | "assurance"
    | "physical"
    | "phase2";
  readonly cursor: CursorState | null;
  readonly prepared: PreparedBatch | null;
  readonly assurance: AssuranceEvidence | null;
  readonly integrations: readonly PhysicalIntegrationReceipt[];
  readonly integrationIndex: number;
  readonly budgetEpoch: string | null;
  readonly ordinal: number;
}

export function freezePreparationState(
  input: PreparationState,
): PreparationState {
  return Object.freeze(input);
}

export function contextBindingsFor(state: PreparationState): ContextBindings {
  const continuation = continuationBindingsFor(state);
  return Object.freeze({
    requestDigest: continuation.requestDigest,
    repositoryId: continuation.repositoryId,
    treeDigest: continuation.treeDigest,
    baselineDigest: continuation.baselineDigest,
    provenanceDigest: continuation.provenanceDigest,
    candidateDigest: continuation.candidateDigest,
    cursorDigest: continuation.cursorDigest,
  });
}

export function continuationBindingsFor(
  state: PreparationState,
): ContinuationBindings {
  const candidateDigest =
    state.prepared?.receipt.candidateDigest ??
    state.cursor?.cursor.candidateDigest ??
    digestValue({
      contextDigest: state.context.receipt.contextDigest,
      baselineDigest: state.baseline.baselineDigest,
    });
  const provenanceDigest =
    state.assurance?.receipt.receiptDigest ??
    state.prepared?.receipt.provenanceDigest ??
    state.cursor?.cursor.stateDigest ??
    state.context.receipt.receiptDigest;
  const cursorDigest =
    state.cursor === null
      ? digestValue({
          phase: state.phase,
          integrationIndex: state.integrationIndex,
          ordinal: state.ordinal,
        })
      : sourceCursorDigest(state.cursor.cursor, state.cursor.next);
  return Object.freeze({
    requestDigest: state.input.request.intentDigest,
    repositoryId: state.input.repository.repositoryId,
    treeDigest: state.input.repository.treeDigest,
    baselineDigest: state.baseline.baselineDigest,
    provenanceDigest,
    candidateDigest,
    cursorDigest,
    budgetEpoch: state.budgetEpoch ?? "unassigned",
  });
}

export function operationFor(state: PreparationState) {
  if (state.phase === "source-start") return "source-start";
  if (state.phase === "source-advance") return "source-advance";
  if (state.phase === "assurance") return "change-assurance";
  if (state.phase === "physical") return "physical-integration";
  return "phase2-prepare";
}

export function sameContinuationBindings(
  left: ContinuationBindings,
  right: ContinuationBindings,
): boolean {
  return digestValue(left) === digestValue(right);
}
