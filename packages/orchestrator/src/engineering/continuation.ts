import { types } from "node:util";
import { type Digest, digestValue } from "../digest.ts";
import { snapshotRecord } from "./snapshot.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export interface EngineeringContinuation {
  readonly continuationId: Digest;
  readonly continuationDigest: Digest;
}

export interface ContinuationBindings {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly treeDigest: Digest;
  readonly baselineDigest: Digest;
  readonly provenanceDigest: Digest;
  readonly candidateDigest: Digest;
  readonly cursorDigest: Digest;
  readonly budgetEpoch: string;
}

interface ContinuationEntry<State> {
  readonly bindings: ContinuationBindings;
  readonly state: State;
}

export type ContinuationResult<State> =
  | { readonly status: "accepted"; readonly state: State }
  | {
      readonly status: "rejected";
      readonly code: "CONTINUATION_REJECTED" | "CONTINUATION_DRIFTED";
    };

export type ContinuationClaim<State> =
  | {
      readonly status: "accepted";
      readonly state: State;
      readonly bindings: ContinuationBindings;
    }
  | { readonly status: "rejected"; readonly code: "CONTINUATION_REJECTED" };

export type ContinuationIssueResult =
  | {
      readonly status: "issued";
      readonly continuation: EngineeringContinuation;
    }
  | { readonly status: "rejected"; readonly code: "CONTINUATION_REJECTED" };

export class ContinuationLedger<State extends object> {
  private sequence = 0;
  private readonly entries = new WeakMap<object, ContinuationEntry<State>>();

  issue(bindings: ContinuationBindings, state: State): ContinuationIssueResult {
    const safeBindings = parseBindings(bindings);
    if (safeBindings === undefined || !validFrozenState(state)) {
      return { status: "rejected", code: "CONTINUATION_REJECTED" };
    }
    this.sequence += 1;
    const continuationId = digestValue({
      sequence: this.sequence,
      requestDigest: safeBindings.requestDigest,
      repositoryId: safeBindings.repositoryId,
      treeDigest: safeBindings.treeDigest,
      baselineDigest: safeBindings.baselineDigest,
      cursorDigest: safeBindings.cursorDigest,
      budgetEpoch: safeBindings.budgetEpoch,
    });
    const continuation = Object.freeze({
      continuationId,
      continuationDigest: digestValue({ continuationId, ...safeBindings }),
    });
    this.entries.set(continuation, {
      bindings: safeBindings,
      state,
    });
    return { status: "issued", continuation };
  }

  consume(
    value: unknown,
    current: ContinuationBindings,
  ): ContinuationResult<State> {
    const claim = this.claim(value);
    if (claim.status !== "accepted") return claim;
    const safeCurrent = parseBindings(current);
    if (
      safeCurrent === undefined ||
      !sameBindings(claim.bindings, safeCurrent)
    ) {
      return { status: "rejected", code: "CONTINUATION_DRIFTED" };
    }
    return { status: "accepted", state: claim.state };
  }

  claim(value: unknown): ContinuationClaim<State> {
    if (typeof value !== "object" || value === null) {
      return { status: "rejected", code: "CONTINUATION_REJECTED" };
    }
    const entry = this.entries.get(value);
    if (entry === undefined) {
      return { status: "rejected", code: "CONTINUATION_REJECTED" };
    }
    this.entries.delete(value);
    return {
      status: "accepted",
      state: entry.state,
      bindings: entry.bindings,
    };
  }
}

function parseBindings(value: unknown): ContinuationBindings | undefined {
  const snapshot = snapshotRecord(value, [
    "requestDigest",
    "repositoryId",
    "treeDigest",
    "baselineDigest",
    "provenanceDigest",
    "candidateDigest",
    "cursorDigest",
    "budgetEpoch",
  ]);
  if (
    !(
      snapshot !== undefined &&
      validDigest(snapshot["requestDigest"]) &&
      validIdentity(snapshot["repositoryId"]) &&
      validDigest(snapshot["treeDigest"]) &&
      validDigest(snapshot["baselineDigest"]) &&
      validDigest(snapshot["provenanceDigest"]) &&
      validDigest(snapshot["candidateDigest"]) &&
      validDigest(snapshot["cursorDigest"]) &&
      validIdentity(snapshot["budgetEpoch"])
    )
  ) {
    return;
  }
  return Object.freeze({
    requestDigest: snapshot["requestDigest"],
    repositoryId: snapshot["repositoryId"],
    treeDigest: snapshot["treeDigest"],
    baselineDigest: snapshot["baselineDigest"],
    provenanceDigest: snapshot["provenanceDigest"],
    candidateDigest: snapshot["candidateDigest"],
    cursorDigest: snapshot["cursorDigest"],
    budgetEpoch: snapshot["budgetEpoch"],
  });
}

function validFrozenState(value: object): boolean {
  return validFrozenValue(value, new WeakSet<object>());
}

function validFrozenValue(value: unknown, seen: WeakSet<object>): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined" ||
    typeof value === "function"
  ) {
    return true;
  }
  if (typeof value !== "object" || types.isProxy(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    if (!Object.isFrozen(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== Array.prototype &&
      prototype !== null
    ) {
      return false;
    }
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key === "symbol") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        "value" in descriptor &&
        validFrozenValue(descriptor.value, seen)
      );
    });
  } catch {
    return false;
  }
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes("\0")
  );
}

function sameBindings(
  left: ContinuationBindings,
  right: ContinuationBindings,
): boolean {
  return (
    left.requestDigest === right.requestDigest &&
    left.repositoryId === right.repositoryId &&
    left.treeDigest === right.treeDigest &&
    left.baselineDigest === right.baselineDigest &&
    left.provenanceDigest === right.provenanceDigest &&
    left.candidateDigest === right.candidateDigest &&
    left.cursorDigest === right.cursorDigest &&
    left.budgetEpoch === right.budgetEpoch
  );
}
