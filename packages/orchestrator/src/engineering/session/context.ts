import { type Digest, digestValue } from "../../digest.ts";
import { snapshotRecord } from "./snapshot.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumOrdinal = 4096;

export type ContextOperation =
  | "source-describe"
  | "source-start"
  | "source-advance"
  | "change-assurance"
  | "security-review"
  | "physical-integration"
  | "phase2-prepare";

export interface ContextBindings {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly treeDigest: Digest;
  readonly baselineDigest: Digest;
  readonly provenanceDigest: Digest;
  readonly candidateDigest: Digest;
  readonly cursorDigest: Digest;
}

export interface ContextReserveRequest {
  readonly version: 1;
  readonly operation: ContextOperation;
  readonly ordinal: number;
  readonly expectedEpoch: string | null;
  readonly bindings: ContextBindings;
}

export interface ContextBudgetAuthorityPort {
  reserve: (input: ContextReserveRequest) => unknown | Promise<unknown>;
}

export interface ContextReservation {
  readonly status: "reserved";
  readonly epoch: string;
  readonly reservationId: string;
  readonly requestDigest: Digest;
  readonly usedUnits: number;
  readonly limitUnits: number;
  readonly completionReserveUnits: number;
  readonly requiredUnits: number;
}

export interface ContextPause {
  readonly status: "paused";
  readonly epoch: string;
  readonly requestDigest: Digest;
  readonly usedUnits: number;
  readonly limitUnits: number;
  readonly completionReserveUnits: number;
  readonly requiredUnits: number;
}

export type ContextReserveResult =
  | { readonly status: "reserved"; readonly receipt: ContextReservation }
  | { readonly status: "paused"; readonly receipt: ContextPause }
  | {
      readonly status: "rejected";
      readonly code: "CONTEXT_BUDGET_REJECTED" | "CONTEXT_BUDGET_DRIFTED";
    };

export async function reserveContext(
  authority: ContextBudgetAuthorityPort,
  input: Omit<ContextReserveRequest, "version">,
): Promise<ContextReserveResult> {
  const request = Object.freeze({
    version: 1 as const,
    operation: input.operation,
    ordinal: input.ordinal,
    expectedEpoch: input.expectedEpoch,
    bindings: input.bindings,
  });
  if (!validRequest(request)) {
    return { status: "rejected", code: "CONTEXT_BUDGET_REJECTED" };
  }
  const requestDigest = digestValue(request);
  let raw: unknown;
  try {
    raw = await authority.reserve(request);
  } catch {
    return { status: "rejected", code: "CONTEXT_BUDGET_REJECTED" };
  }
  const decision = parseDecision(raw, requestDigest);
  if (decision === undefined) {
    return { status: "rejected", code: "CONTEXT_BUDGET_REJECTED" };
  }
  if (
    input.expectedEpoch !== null &&
    decision.receipt.epoch !== input.expectedEpoch
  ) {
    return { status: "rejected", code: "CONTEXT_BUDGET_DRIFTED" };
  }
  return decision;
}

function validRequest(value: ContextReserveRequest): boolean {
  return (
    validOperation(value.operation) &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal >= 0 &&
    value.ordinal <= maximumOrdinal &&
    (value.expectedEpoch === null || validIdentity(value.expectedEpoch)) &&
    validBindings(value.bindings)
  );
}

function validBindings(value: ContextBindings): boolean {
  return (
    validDigest(value.requestDigest) &&
    validIdentity(value.repositoryId) &&
    validDigest(value.treeDigest) &&
    validDigest(value.baselineDigest) &&
    validDigest(value.provenanceDigest) &&
    validDigest(value.candidateDigest) &&
    validDigest(value.cursorDigest)
  );
}

function parseDecision(
  value: unknown,
  requestDigest: Digest,
):
  | { readonly status: "reserved"; readonly receipt: ContextReservation }
  | { readonly status: "paused"; readonly receipt: ContextPause }
  | undefined {
  const status = snapshotRecord(
    value,
    ["status"],
    [
      "epoch",
      "reservationId",
      "requestDigest",
      "usedUnits",
      "limitUnits",
      "completionReserveUnits",
      "requiredUnits",
    ],
  );
  if (status?.["status"] === "paused") {
    const paused = snapshotRecord(value, [
      "status",
      "epoch",
      "requestDigest",
      "usedUnits",
      "limitUnits",
      "completionReserveUnits",
      "requiredUnits",
    ]);
    if (
      !(
        paused !== undefined &&
        validIdentity(paused["epoch"]) &&
        paused["requestDigest"] === requestDigest &&
        validBudgetEvidence(paused) &&
        !fitsBudget(paused)
      )
    ) {
      return;
    }
    return {
      status: "paused",
      receipt: Object.freeze({
        status: "paused",
        epoch: paused["epoch"],
        requestDigest,
        usedUnits: paused.usedUnits,
        limitUnits: paused.limitUnits,
        completionReserveUnits: paused.completionReserveUnits,
        requiredUnits: paused.requiredUnits,
      }),
    };
  }
  const reserved = snapshotRecord(value, [
    "status",
    "epoch",
    "reservationId",
    "requestDigest",
    "usedUnits",
    "limitUnits",
    "completionReserveUnits",
    "requiredUnits",
  ]);
  if (
    !(
      reserved !== undefined &&
      reserved["status"] === "reserved" &&
      validIdentity(reserved["epoch"]) &&
      validIdentity(reserved["reservationId"]) &&
      reserved["requestDigest"] === requestDigest &&
      validBudgetEvidence(reserved) &&
      fitsBudget(reserved)
    )
  ) {
    return;
  }
  return {
    status: "reserved",
    receipt: Object.freeze({
      status: "reserved",
      epoch: reserved["epoch"],
      reservationId: reserved["reservationId"],
      requestDigest,
      usedUnits: reserved.usedUnits,
      limitUnits: reserved.limitUnits,
      completionReserveUnits: reserved.completionReserveUnits,
      requiredUnits: reserved.requiredUnits,
    }),
  };
}

function validOperation(value: unknown): value is ContextOperation {
  return (
    value === "source-start" ||
    value === "source-describe" ||
    value === "source-advance" ||
    value === "change-assurance" ||
    value === "security-review" ||
    value === "physical-integration" ||
    value === "phase2-prepare"
  );
}

interface BudgetEvidence {
  readonly usedUnits: number;
  readonly limitUnits: number;
  readonly completionReserveUnits: number;
  readonly requiredUnits: number;
}

function validBudgetEvidence(value: unknown): value is BudgetEvidence {
  const budget = snapshotRecord(
    value,
    ["usedUnits", "limitUnits", "completionReserveUnits", "requiredUnits"],
    ["status", "epoch", "reservationId", "requestDigest"],
  );
  return (
    budget !== undefined &&
    nonnegativeSafeInteger(budget["usedUnits"]) &&
    nonnegativeSafeInteger(budget["limitUnits"]) &&
    nonnegativeSafeInteger(budget["completionReserveUnits"]) &&
    nonnegativeSafeInteger(budget["requiredUnits"])
  );
}

function fitsBudget(value: BudgetEvidence): boolean {
  if (
    value.usedUnits > Number.MAX_SAFE_INTEGER - value.requiredUnits ||
    value.usedUnits + value.requiredUnits >
      Number.MAX_SAFE_INTEGER - value.completionReserveUnits
  ) {
    return false;
  }
  return (
    value.usedUnits + value.requiredUnits + value.completionReserveUnits <=
    value.limitUnits
  );
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
