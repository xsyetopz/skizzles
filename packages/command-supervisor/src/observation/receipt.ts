import { createHash } from "node:crypto";
import type { ProcessTreeCleanup } from "../codex-command/process-tree.ts";

export type CommandOutputStream = "stdout" | "stderr";
export type CommandObservationOutcome =
  | "exited"
  | "signaled"
  | "timed-out"
  | "aborted"
  | "invalid-spec"
  | "spawn-failed"
  | "output-limit";

export type CommandObservationResult =
  | Readonly<{
      kind: "invalid-spec";
      exitCode: null;
      signal: null;
      failureCode: "INVALID_SPEC";
      outputLimitStream: null;
    }>
  | Readonly<{
      kind: Exclude<CommandObservationOutcome, "invalid-spec">;
      exitCode: number | null;
      signal: string | null;
      failureCode: string | null;
      outputLimitStream: CommandOutputStream | null;
    }>;

export interface CommandStreamEvidence {
  readonly observedBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
  readonly sha256: string;
}

export interface CommandObservationReceipt {
  readonly schema: "skizzles.command-supervisor/observation-receipt";
  readonly version: 1;
  readonly invocationSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: CommandObservationResult;
  readonly lifecycle: Readonly<{
    drain: "complete" | "incomplete" | "not-started";
    cleanup: ProcessTreeCleanup;
  }>;
  readonly stdout: Readonly<CommandStreamEvidence>;
  readonly stderr: Readonly<CommandStreamEvidence>;
  readonly receiptSha256: string;
}

interface ReceiptInput {
  readonly invocationSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: CommandObservationReceipt["outcome"];
  readonly lifecycle: CommandObservationReceipt["lifecycle"];
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutObservedBytes: number;
  readonly stderrObservedBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

interface RetainedOutput {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

const retainedOutput = new WeakMap<CommandObservationReceipt, RetainedOutput>();

function digest(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function evidence(
  bytes: Uint8Array,
  observedBytes: number,
  truncated: boolean,
): Readonly<CommandStreamEvidence> {
  return Object.freeze({
    observedBytes,
    retainedBytes: bytes.length,
    truncated,
    sha256: digest(bytes),
  });
}

export function createObservationReceipt(
  input: ReceiptInput,
): CommandObservationReceipt {
  const stdout = Uint8Array.from(input.stdout);
  const stderr = Uint8Array.from(input.stderr);
  const unsigned = Object.freeze({
    schema: "skizzles.command-supervisor/observation-receipt" as const,
    version: 1 as const,
    invocationSha256: input.invocationSha256,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    outcome: Object.freeze({ ...input.outcome }),
    lifecycle: Object.freeze({ ...input.lifecycle }),
    stdout: evidence(stdout, input.stdoutObservedBytes, input.stdoutTruncated),
    stderr: evidence(stderr, input.stderrObservedBytes, input.stderrTruncated),
  });
  const receipt: CommandObservationReceipt = Object.freeze({
    ...unsigned,
    receiptSha256: digest(JSON.stringify(unsigned)),
  });
  retainedOutput.set(receipt, { stdout, stderr });
  return receipt;
}

export function recoverCommandOutput(
  receipt: CommandObservationReceipt,
  stream: CommandOutputStream,
): Uint8Array {
  if (stream !== "stdout" && stream !== "stderr") {
    throw new TypeError("command output stream is invalid");
  }
  const output = retainedOutput.get(receipt);
  if (!output) {
    throw new TypeError("command observation receipt is not authentic");
  }
  const bytes = output[stream];
  const expected = receipt[stream];
  if (
    bytes.length !== expected.retainedBytes ||
    digest(bytes) !== expected.sha256
  ) {
    throw new Error("command observation evidence is inconsistent");
  }
  return Uint8Array.from(bytes);
}
