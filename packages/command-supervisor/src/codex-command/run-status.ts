import { createHash } from "node:crypto";
import type {
  RunSettings,
  StreamCaptureState,
  SupervisedSignal,
} from "./command-contract.ts";

const runStatusSchema = "skizzles.command-supervisor/run-status";
const runStatusVersion = 1;
const operatorActionLabel = "operator shell action";
const failedStartExitCode = 127;

type CleanupOutcome = "pending" | "not-required" | "terminated" | "killed";

interface EvidenceReference {
  reference: "stdout.log" | "stderr.log";
  sensitivity: "operator-private";
  redaction: "none";
  integrity: "unauthenticated-sha256";
  observedBytes: number;
  storedBytes: number;
  truncated: boolean;
  sha256: string;
}

interface RunStatus {
  schema: typeof runStatusSchema;
  version: typeof runStatusVersion;
  id: string;
  action: {
    label: typeof operatorActionLabel;
    sha256: string;
    sensitivity: "secret-bearing";
    redaction: "content-omitted";
  };
  execution: {
    shell: string;
  };
  retention: {
    policy: "per-output-cap-with-pre-run-completed-cleanup";
    maximumOutputArtifactBytes: number;
    cleanupThresholdBytes: number;
    directoryMode: "0700";
    fileMode: "0600";
  };
  evidence: {
    stdout: EvidenceReference;
    stderr: EvidenceReference;
  };
  lifecycle: {
    state: "running" | "completed" | "failed-to-start";
    startedAt: string;
    completedAt: string | null;
    exitCode: number | null;
    cancellationSignal: SupervisedSignal | null;
    drain: "pending" | "complete" | "incomplete";
    cleanup: CleanupOutcome;
  };
  artifactCapture: "active" | "unavailable";
}

interface CreateRunStatusInput {
  id: string;
  script: string;
  shell: string;
  settings: RunSettings;
  artifactCapture: RunStatus["artifactCapture"];
}

interface CompleteRunInput {
  exitCode: number;
  signal: SupervisedSignal | undefined;
  drainedNaturally: boolean;
  cleanup: Exclude<CleanupOutcome, "pending">;
}

function sha256Digest(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function emptyEvidence(
  reference: EvidenceReference["reference"],
): EvidenceReference {
  return {
    reference,
    sensitivity: "operator-private",
    redaction: "none",
    integrity: "unauthenticated-sha256",
    observedBytes: 0,
    storedBytes: 0,
    truncated: false,
    sha256: sha256Digest(new Uint8Array()),
  };
}

function createRunStatus(input: CreateRunStatusInput): RunStatus {
  return {
    schema: runStatusSchema,
    version: runStatusVersion,
    id: input.id,
    action: {
      label: operatorActionLabel,
      sha256: sha256Digest(input.script),
      sensitivity: "secret-bearing",
      redaction: "content-omitted",
    },
    execution: { shell: input.shell },
    retention: {
      policy: "per-output-cap-with-pre-run-completed-cleanup",
      maximumOutputArtifactBytes: input.settings.maximumBytes,
      cleanupThresholdBytes: input.settings.maximumDiskBytes,
      directoryMode: "0700",
      fileMode: "0600",
    },
    evidence: {
      stdout: emptyEvidence("stdout.log"),
      stderr: emptyEvidence("stderr.log"),
    },
    lifecycle: {
      state: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      cancellationSignal: null,
      drain: "pending",
      cleanup: "pending",
    },
    artifactCapture: input.artifactCapture,
  };
}

function updateEvidence(
  evidence: EvidenceReference,
  capture: StreamCaptureState,
): void {
  evidence.observedBytes = capture.observedBytes;
  evidence.storedBytes = capture.storedBytes;
  evidence.truncated = capture.truncated;
  evidence.sha256 = capture.retainedSha256.copy().digest("hex");
}

function syncRunEvidence(
  status: RunStatus,
  stdout: StreamCaptureState,
  stderr: StreamCaptureState,
): void {
  updateEvidence(status.evidence.stdout, stdout);
  updateEvidence(status.evidence.stderr, stderr);
}

function failRunStart(status: RunStatus): void {
  status.lifecycle.state = "failed-to-start";
  status.lifecycle.completedAt = new Date().toISOString();
  status.lifecycle.exitCode = failedStartExitCode;
  status.lifecycle.drain = "complete";
  status.lifecycle.cleanup = "not-required";
}

function completeRun(status: RunStatus, input: CompleteRunInput): void {
  status.lifecycle.state = "completed";
  status.lifecycle.completedAt = new Date().toISOString();
  status.lifecycle.exitCode = input.exitCode;
  status.lifecycle.cancellationSignal = input.signal ?? null;
  status.lifecycle.drain = "incomplete";
  if (input.drainedNaturally) {
    status.lifecycle.drain = "complete";
  }
  status.lifecycle.cleanup = input.cleanup;
}

export type { CleanupOutcome, EvidenceReference, RunStatus };
export {
  completeRun,
  createRunStatus,
  failRunStart,
  operatorActionLabel,
  runStatusSchema,
  runStatusVersion,
  sha256Digest,
  syncRunEvidence,
};
