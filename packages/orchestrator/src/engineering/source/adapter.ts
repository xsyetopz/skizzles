import {
  isStructuralEvidenceReceipt,
  type StructuralEvidenceReceipt,
} from "@skizzles/source-transformation";
import { type Digest, digestBytes, digestValue } from "../../digest.ts";
import type { SourceEngineeringPort } from "../contract.ts";
import {
  isFrozenOpaque,
  snapshotArray,
  snapshotRecord,
} from "../session/snapshot.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumSourceBytes = 1_500_000;
const maximumSteps = 4096;

export interface SourceCursor {
  readonly cursorId: string;
  readonly requestDigest: Digest;
  readonly stateDigest: Digest;
  readonly candidateDigest: Digest;
  readonly step: number;
  readonly totalSteps: number;
}

export interface SourceNextOperation {
  readonly kind: "edit" | "format" | "validate";
  readonly ordinal: number;
  readonly epoch?: number;
}

export interface SourceArtifact {
  readonly path: string;
  readonly baselineDigest: Digest;
  readonly baselineByteLength: number;
  readonly digest: Digest;
  readonly byteLength: number;
  readonly readBaselineBytes: () => Uint8Array;
  readonly readBytes: () => Uint8Array;
}

export interface SourceReceipt {
  readonly requestDigest: Digest;
  readonly contextDigest: Digest;
  readonly contextReceiptDigest: Digest;
  readonly baselineDigest: Digest;
  readonly candidateDigest: Digest;
  readonly candidateManifestDigest: Digest;
  readonly targetReceipts: readonly SourceTargetReceipt[];
  readonly observedNegativeTests: readonly SourceObservedNegativeTest[];
  readonly provenanceDigest: Digest;
  readonly validationDigest: Digest;
  readonly compilerReceipt: Readonly<{ readonly receiptDigest: Digest }>;
  readonly structuralReceipt: StructuralEvidenceReceipt;
}

export interface SourceObservedNegativeTest {
  readonly productionPath: string;
  readonly testPath: string;
  readonly failureCodes: readonly string[];
}

export interface SourceTargetReceipt {
  readonly path: string;
  readonly baselineSemanticDigest: Digest;
  readonly candidateSemanticDigest: Digest;
  readonly baselineDigest: Digest;
  readonly candidateDigest: Digest;
}

export type SourceStepResult =
  | {
      readonly status: "ready";
      readonly cursor: SourceCursor;
      readonly cursorReference: object;
      readonly next: SourceNextOperation;
    }
  | {
      readonly status: "prepared";
      readonly artifacts: readonly SourceArtifact[];
      readonly artifactReferences: readonly object[];
      readonly receipt: SourceReceipt;
      readonly receiptReference: object;
    }
  | {
      readonly status: "rejected";
      readonly code: "SOURCE_ENGINEERING_REJECTED";
    };

export async function startSourceEngineering(
  engine: SourceEngineeringPort,
  input: unknown,
): Promise<SourceStepResult> {
  try {
    return parseStep(engine.start(input));
  } catch {
    return rejected();
  }
}

export async function advanceSourceEngineering(
  engine: SourceEngineeringPort,
  cursor: object,
): Promise<SourceStepResult> {
  try {
    return parseStep(await engine.advance(Object.freeze({ cursor })));
  } catch {
    return rejected();
  }
}

export async function verifySourceEngineering(
  engine: SourceEngineeringPort,
  artifacts: readonly object[],
  receipt: object,
  expected: {
    readonly candidateDigest: Digest;
    readonly provenanceDigest: Digest;
    readonly validationDigest: Digest;
  },
): Promise<boolean> {
  let raw: unknown;
  try {
    raw = engine.verify(Object.freeze({ artifacts, receipt }));
  } catch {
    return false;
  }
  const value = snapshotRecord(raw, [
    "status",
    "candidateDigest",
    "provenanceDigest",
    "validationDigest",
  ]);
  return (
    value !== undefined &&
    value["status"] === "valid" &&
    value["candidateDigest"] === expected.candidateDigest &&
    value["provenanceDigest"] === expected.provenanceDigest &&
    value["validationDigest"] === expected.validationDigest
  );
}

export function readSourceArtifact(
  artifact: SourceArtifact,
): readonly number[] | undefined {
  let bytes: Uint8Array;
  try {
    bytes = artifact.readBytes();
  } catch {
    return;
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== artifact.byteLength ||
    bytes.byteLength > maximumSourceBytes ||
    digestBytes(bytes) !== artifact.digest
  ) {
    return;
  }
  return Object.freeze(Array.from(bytes));
}

export function readSourceBaseline(
  artifact: SourceArtifact,
): readonly number[] | undefined {
  let bytes: Uint8Array;
  try {
    bytes = artifact.readBaselineBytes();
  } catch {
    return;
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== artifact.baselineByteLength ||
    bytes.byteLength > maximumSourceBytes ||
    digestBytes(bytes) !== artifact.baselineDigest
  ) {
    return;
  }
  return Object.freeze(Array.from(bytes));
}

export function sourceCursorDigest(
  cursor: SourceCursor,
  next: SourceNextOperation,
): Digest {
  return digestValue({ cursor, next });
}

function parseStep(input: unknown): SourceStepResult {
  const value = snapshotRecord(
    input,
    ["status"],
    ["cursor", "next", "artifacts", "receipt"],
  );
  if (value === undefined) return rejected();
  if (value["status"] === "ready") {
    const exact = snapshotRecord(input, ["status", "cursor", "next"]);
    const cursor = parseCursor(exact?.["cursor"]);
    const next = parseNext(exact?.["next"]);
    if (
      exact === undefined ||
      cursor === undefined ||
      next === undefined ||
      !isFrozenOpaque(exact["cursor"])
    ) {
      return rejected();
    }
    return {
      status: "ready",
      cursor,
      cursorReference: exact["cursor"],
      next,
    };
  }
  if (value["status"] !== "prepared") return rejected();
  const exact = snapshotRecord(input, ["status", "artifacts", "receipt"]);
  const artifactValues = snapshotArray(exact?.["artifacts"], maximumSteps);
  const artifacts = artifactValues?.map(parseArtifact);
  const receipt = parseReceipt(exact?.["receipt"]);
  if (
    exact === undefined ||
    artifactValues === undefined ||
    artifactValues.length === 0 ||
    artifacts === undefined ||
    artifacts.some((artifact) => artifact === undefined) ||
    !isFrozenObjectArray(exact["artifacts"], artifactValues) ||
    receipt === undefined ||
    !sameArtifactReceipts(artifacts, receipt.targetReceipts) ||
    artifactValues.some((artifact) => !isFrozenOpaque(artifact)) ||
    !isFrozenOpaque(exact["receipt"])
  ) {
    return rejected();
  }
  return {
    status: "prepared",
    artifacts: Object.freeze(
      artifacts.filter(
        (artifact): artifact is SourceArtifact => artifact !== undefined,
      ),
    ),
    artifactReferences: exact["artifacts"],
    receipt,
    receiptReference: exact["receipt"],
  };
}

function isFrozenObjectArray(
  value: unknown,
  snapshot: readonly unknown[],
): value is readonly object[] {
  return (
    Array.isArray(value) &&
    Object.isFrozen(value) &&
    value.length === snapshot.length &&
    snapshot.every(
      (item) =>
        typeof item === "object" && item !== null && isFrozenOpaque(item),
    )
  );
}

function parseCursor(input: unknown): SourceCursor | undefined {
  const value = snapshotRecord(input, [
    "cursorId",
    "requestDigest",
    "stateDigest",
    "candidateDigest",
    "step",
    "totalSteps",
  ]);
  if (
    !(
      value !== undefined &&
      typeof value["cursorId"] === "string" &&
      value["cursorId"].length > 0 &&
      validDigest(value["requestDigest"]) &&
      validDigest(value["stateDigest"]) &&
      validDigest(value["candidateDigest"]) &&
      nonnegativeInteger(value["step"]) &&
      positiveInteger(value["totalSteps"]) &&
      value["totalSteps"] <= maximumSteps &&
      value["step"] < value["totalSteps"]
    )
  ) {
    return;
  }
  return Object.freeze({
    cursorId: value["cursorId"],
    requestDigest: value["requestDigest"],
    stateDigest: value["stateDigest"],
    candidateDigest: value["candidateDigest"],
    step: value["step"],
    totalSteps: value["totalSteps"],
  });
}

function parseNext(input: unknown): SourceNextOperation | undefined {
  const value = snapshotRecord(input, ["kind", "ordinal"], ["epoch"]);
  if (
    !(
      value !== undefined &&
      (value["kind"] === "edit" ||
        value["kind"] === "format" ||
        value["kind"] === "validate") &&
      nonnegativeInteger(value["ordinal"]) &&
      value["ordinal"] <= maximumSteps &&
      (value["epoch"] === undefined || positiveInteger(value["epoch"]))
    )
  ) {
    return;
  }
  return Object.freeze({
    kind: value["kind"],
    ordinal: value["ordinal"],
    ...(value["epoch"] === undefined ? {} : { epoch: value["epoch"] }),
  });
}

function parseArtifact(input: unknown): SourceArtifact | undefined {
  const value = snapshotRecord(input, [
    "path",
    "baselineDigest",
    "baselineByteLength",
    "digest",
    "byteLength",
    "readBaselineBytes",
    "readBytes",
  ]);
  const reader = value?.["readBytes"];
  const baselineReader = value?.["readBaselineBytes"];
  if (
    !(
      value !== undefined &&
      typeof value["path"] === "string" &&
      value["path"].length > 0 &&
      validDigest(value["baselineDigest"]) &&
      nonnegativeInteger(value["baselineByteLength"]) &&
      value["baselineByteLength"] <= maximumSourceBytes &&
      validDigest(value["digest"]) &&
      nonnegativeInteger(value["byteLength"]) &&
      value["byteLength"] <= maximumSourceBytes &&
      typeof baselineReader === "function" &&
      typeof reader === "function"
    )
  ) {
    return;
  }
  return Object.freeze({
    path: value["path"],
    baselineDigest: value["baselineDigest"],
    baselineByteLength: value["baselineByteLength"],
    digest: value["digest"],
    byteLength: value["byteLength"],
    readBaselineBytes: (): Uint8Array => {
      const result: unknown = Reflect.apply(baselineReader, undefined, []);
      if (!(result instanceof Uint8Array)) {
        throw new Error("source artifact returned invalid baseline bytes");
      }
      return result;
    },
    readBytes: (): Uint8Array => {
      const result: unknown = Reflect.apply(reader, undefined, []);
      if (!(result instanceof Uint8Array)) {
        throw new Error("source artifact returned invalid bytes");
      }
      return result;
    },
  });
}

function parseReceipt(input: unknown): SourceReceipt | undefined {
  const value = snapshotRecord(input, [
    "requestDigest",
    "contextDigest",
    "contextReceiptDigest",
    "baselineDigest",
    "candidateDigest",
    "candidateManifestDigest",
    "targetReceipts",
    "indexReceipt",
    "compilerReceipt",
    "structuralReceipt",
    "policyReceipt",
    "provenanceDigest",
    "validationDigest",
  ]);
  const targetValues = snapshotArray(value?.["targetReceipts"], maximumSteps);
  const targetReceipts = targetValues?.map(parseTargetReceipt);
  const policy = parsePolicyReceipt(value?.["policyReceipt"]);
  const compilerReceipt = snapshotRecord(value?.["compilerReceipt"], [
    "receipts",
    "receiptDigest",
  ]);
  if (
    !(
      value !== undefined &&
      validDigest(value["requestDigest"]) &&
      validDigest(value["contextDigest"]) &&
      validDigest(value["contextReceiptDigest"]) &&
      validDigest(value["baselineDigest"]) &&
      validDigest(value["candidateDigest"]) &&
      validDigest(value["candidateManifestDigest"]) &&
      targetValues !== undefined &&
      targetValues.length > 0 &&
      targetReceipts !== undefined &&
      targetReceipts.every((receipt) => receipt !== undefined) &&
      isFrozenOpaque(value["indexReceipt"]) &&
      compilerReceipt !== undefined &&
      validDigest(compilerReceipt["receiptDigest"]) &&
      isFrozenOpaque(value["compilerReceipt"]) &&
      isStructuralEvidenceReceipt(value["structuralReceipt"]) &&
      policy !== undefined &&
      validDigest(value["provenanceDigest"]) &&
      validDigest(value["validationDigest"])
    )
  ) {
    return;
  }
  return Object.freeze({
    requestDigest: value["requestDigest"],
    contextDigest: value["contextDigest"],
    contextReceiptDigest: value["contextReceiptDigest"],
    baselineDigest: value["baselineDigest"],
    candidateDigest: value["candidateDigest"],
    candidateManifestDigest: value["candidateManifestDigest"],
    targetReceipts: Object.freeze(
      targetReceipts.filter(
        (receipt): receipt is SourceTargetReceipt => receipt !== undefined,
      ),
    ),
    observedNegativeTests: policy.observedNegativeTests,
    provenanceDigest: value["provenanceDigest"],
    validationDigest: value["validationDigest"],
    compilerReceipt: Object.freeze({
      receiptDigest: compilerReceipt["receiptDigest"],
    }),
    structuralReceipt: value["structuralReceipt"],
  });
}

function parsePolicyReceipt(
  input: unknown,
):
  | { readonly observedNegativeTests: readonly SourceObservedNegativeTest[] }
  | undefined {
  const value = snapshotRecord(input, [
    "findingCount",
    "changeSetDigest",
    "literalRegistryDigest",
    "observedNegativeTests",
    "faultEvidenceDigest",
    "receiptDigest",
  ]);
  const observedValues = snapshotArray(
    value?.["observedNegativeTests"],
    maximumSteps,
  );
  if (
    value === undefined ||
    value["findingCount"] !== 0 ||
    !validDigest(value["changeSetDigest"]) ||
    !validDigest(value["literalRegistryDigest"]) ||
    !validDigest(value["faultEvidenceDigest"]) ||
    !validDigest(value["receiptDigest"]) ||
    observedValues === undefined
  ) {
    return;
  }
  const observedNegativeTests: SourceObservedNegativeTest[] = [];
  const paths = new Set<string>();
  for (const raw of observedValues) {
    const observed = snapshotRecord(raw, [
      "productionPath",
      "testPath",
      "failureCodes",
    ]);
    const failureValues = snapshotArray(
      observed?.["failureCodes"],
      maximumSteps,
    );
    if (
      observed === undefined ||
      !validPath(observed["productionPath"]) ||
      !validPath(observed["testPath"]) ||
      paths.has(observed["testPath"]) ||
      failureValues === undefined ||
      failureValues.length === 0 ||
      !failureValues.every(validIdentity)
    ) {
      return;
    }
    paths.add(observed["testPath"]);
    observedNegativeTests.push(
      Object.freeze({
        productionPath: observed["productionPath"],
        testPath: observed["testPath"],
        failureCodes: Object.freeze([...failureValues]),
      }),
    );
  }
  observedNegativeTests.sort((left, right) =>
    left.testPath.localeCompare(right.testPath),
  );
  return Object.freeze({
    observedNegativeTests: Object.freeze(observedNegativeTests),
  });
}

function parseTargetReceipt(input: unknown): SourceTargetReceipt | undefined {
  const value = snapshotRecord(input, [
    "path",
    "baselineDigest",
    "candidateDigest",
    "baselineSemanticDigest",
    "candidateSemanticDigest",
    "templateReceipts",
    "formatterReceipt",
  ]);
  const templateReceipts = snapshotArray(
    value?.["templateReceipts"],
    maximumSteps,
  );
  if (
    !(
      value !== undefined &&
      typeof value["path"] === "string" &&
      value["path"].length > 0 &&
      validDigest(value["baselineDigest"]) &&
      validDigest(value["candidateDigest"]) &&
      validDigest(value["baselineSemanticDigest"]) &&
      validDigest(value["candidateSemanticDigest"]) &&
      templateReceipts !== undefined &&
      templateReceipts.every(isFrozenOpaque) &&
      isFrozenOpaque(value["formatterReceipt"])
    )
  ) {
    return;
  }
  return Object.freeze({
    path: value["path"],
    baselineDigest: value["baselineDigest"],
    candidateDigest: value["candidateDigest"],
    baselineSemanticDigest: value["baselineSemanticDigest"],
    candidateSemanticDigest: value["candidateSemanticDigest"],
  });
}

function sameArtifactReceipts(
  artifacts: readonly (SourceArtifact | undefined)[],
  receipts: readonly SourceTargetReceipt[],
): boolean {
  if (artifacts.length !== receipts.length) return false;
  const sortedArtifacts = [...artifacts].sort((left, right) =>
    (left?.path ?? "").localeCompare(right?.path ?? ""),
  );
  const sortedReceipts = [...receipts].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return sortedArtifacts.every(
    (artifact, index) =>
      artifact !== undefined &&
      artifact.path === sortedReceipts[index]?.path &&
      artifact.baselineDigest === sortedReceipts[index]?.baselineDigest &&
      artifact.digest === sortedReceipts[index]?.candidateDigest,
  );
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

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").includes("..")
  );
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function rejected(): SourceStepResult {
  return { status: "rejected", code: "SOURCE_ENGINEERING_REJECTED" };
}
