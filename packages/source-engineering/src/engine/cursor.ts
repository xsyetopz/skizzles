import { randomUUID } from "node:crypto";
import { digestText } from "../digest.ts";
import type {
  SourceEngineeringArtifact,
  SourceEngineeringCursor,
  SourceEngineeringTaskReceipt,
} from "./contract.ts";
import type {
  BatchState,
  ContextState,
  CursorState,
  PreparedState,
} from "./workflow-state.ts";

export class SourceEngineeringState {
  readonly #contexts = new WeakMap<object, ContextState>();
  readonly #cursors = new WeakMap<object, CursorState>();
  readonly #prepared = new WeakMap<object, PreparedState>();

  registerContext(state: ContextState): void {
    this.#contexts.set(state.receipt, state);
  }

  consumeContext(receipt: object): ContextState | undefined {
    const state = this.#contexts.get(receipt);
    if (state === undefined || state.consumed) return;
    state.consumed = true;
    return state;
  }

  issueCursor(batch: BatchState): SourceEngineeringCursor {
    const step = batch.step;
    const candidateDigest = digestText(
      JSON.stringify(
        batch.targets
          .map(({ path, candidate }) => [path, candidate.text])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ),
    );
    const cursorMaterial = {
      cursorId: randomUUID(),
      requestDigest: batch.request.requestDigest,
      candidateDigest,
      step,
      totalSteps: batch.steps.length,
    };
    const cursor: SourceEngineeringCursor = Object.freeze({
      ...cursorMaterial,
      stateDigest: digestText(JSON.stringify(cursorMaterial)),
    });
    this.#cursors.set(cursor, { cursor, batch, consumed: false });
    return cursor;
  }

  consumeCursor(cursor: object): CursorState | "replayed" | undefined {
    const state = this.#cursors.get(cursor);
    if (state === undefined) return;
    if (state.consumed) return "replayed";
    state.consumed = true;
    return state;
  }

  registerPrepared(input: {
    readonly artifacts: readonly SourceEngineeringArtifact[];
    readonly receipt: SourceEngineeringTaskReceipt;
    readonly baselineBytesByPath: ReadonlyMap<string, readonly number[]>;
    readonly bytesByPath: ReadonlyMap<string, readonly number[]>;
  }): void {
    const state: PreparedState = { ...input, consumed: false };
    this.#prepared.set(input.receipt, state);
    for (const artifact of input.artifacts) this.#prepared.set(artifact, state);
  }

  consumePrepared(receipt: object): PreparedState | "replayed" | undefined {
    const state = this.#prepared.get(receipt);
    if (state === undefined) return;
    if (state.consumed) return "replayed";
    state.consumed = true;
    return state;
  }
}
