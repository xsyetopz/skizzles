import { join } from "node:path";
import process from "node:process";
import { finishCaptures, waitForCaptureDrain } from "../capture-lifecycle.ts";
import type { StreamCaptureState } from "../contract.ts";
import { commandShell, loadRunSettings } from "../settings.ts";
import { spawnSupervisedShell } from "../shell-process.ts";
import {
  captureStream,
  emptyCaptureState,
  printCaptured,
} from "../stream-capture.ts";
import {
  artifactContents,
  artifactTail,
  closeRunArtifacts,
  createRunId,
  prepareRunArtifacts,
  writeStatus,
} from "./artifacts.ts";
import {
  completeRun,
  createRunStatus,
  failRunStart,
  type RunStatus,
  syncRunEvidence,
} from "./status.ts";

function progressReporter(
  startedAt: number,
  stdout: StreamCaptureState,
  stderr: StreamCaptureState,
): () => void {
  let lastReportedStdoutBytes = 0;
  let lastReportedStderrBytes = 0;
  return () => {
    if (
      stdout.observedBytes === lastReportedStdoutBytes &&
      stderr.observedBytes === lastReportedStderrBytes
    ) {
      return;
    }
    const seconds = Math.floor((performance.now() - startedAt) / 1000);
    console.log(
      `| ${seconds}s | ${stdout.observedBytes}B | ${stderr.observedBytes}B |`,
    );
    lastReportedStdoutBytes = stdout.observedBytes;
    lastReportedStderrBytes = stderr.observedBytes;
  };
}

function renderRetainedOutput(
  directory: string,
  status: RunStatus,
  inlineBytes: number,
): void {
  const combinedBytes =
    status.evidence.stdout.observedBytes + status.evidence.stderr.observedBytes;
  const printFullOutput =
    combinedBytes <= inlineBytes &&
    !status.evidence.stdout.truncated &&
    !status.evidence.stderr.truncated;
  if (printFullOutput) {
    printCaptured("stdout", artifactContents(join(directory, "stdout.log")));
    printCaptured("stderr", artifactContents(join(directory, "stderr.log")));
    return;
  }
  printCaptured("stdout tail", artifactTail(join(directory, "stdout.log")));
  printCaptured("stderr tail", artifactTail(join(directory, "stderr.log")));
}

function renderCompletion(status: RunStatus, processStartedAt: number): void {
  if (status.evidence.stdout.truncated || status.evidence.stderr.truncated) {
    console.log(
      `[codex-command] retained out=${status.evidence.stdout.storedBytes}/${status.evidence.stdout.observedBytes}B err=${status.evidence.stderr.storedBytes}/${status.evidence.stderr.observedBytes}B`,
    );
  }
  const outcome = status.lifecycle.cancellationSignal
    ? `signal ${status.lifecycle.cancellationSignal}`
    : `exit ${status.lifecycle.exitCode ?? "unknown"}`;
  const incomplete =
    status.lifecycle.drain === "incomplete" ? " drain-incomplete" : "";
  const elapsedSeconds = Math.floor(
    (performance.now() - processStartedAt) / 1000,
  );
  console.log(`[codex-command] ${outcome} in ${elapsedSeconds}s${incomplete}`);
}

export async function runCommand(script: string): Promise<number> {
  const settings = loadRunSettings();
  const id = createRunId();
  const artifacts = prepareRunArtifacts(
    settings.root,
    id,
    settings.maximumDiskBytes,
  );
  if (artifacts.setupError) {
    console.error(
      `[codex-command] warning: artifact capture unavailable (${artifacts.setupError}); supervising without artifacts`,
    );
  }

  const shell = commandShell();
  const status = createRunStatus({
    id,
    script,
    shell,
    settings,
    artifactCapture: artifacts.available ? "active" : "unavailable",
  });
  writeStatus(artifacts.statusPath, status);
  console.log(
    `[codex-command] artifact: ${artifacts.directory ?? "unavailable"}`,
  );
  console.log("| seconds | out | err |");

  const processStartedAt = performance.now();
  let supervisedShell: ReturnType<typeof spawnSupervisedShell>;
  try {
    supervisedShell = spawnSupervisedShell(
      shell,
      script,
      settings.signalGraceMilliseconds,
    );
  } catch (error) {
    failRunStart(status);
    writeStatus(artifacts.statusPath, status);
    closeRunArtifacts(artifacts);
    console.error(
      `[codex-command] unable to start command: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return 127;
  }

  const shouldForward =
    !artifacts.available ||
    Boolean(process.stdout.isTTY || process.stderr.isTTY);
  const stdoutState = emptyCaptureState();
  const stderrState = emptyCaptureState();
  const captures = [
    captureStream(
      supervisedShell.child.stdout,
      "stdout",
      artifacts.stdoutFile,
      settings.maximumBytes,
      shouldForward,
      stdoutState,
    ),
    captureStream(
      supervisedShell.child.stderr,
      "stderr",
      artifacts.stderrFile,
      settings.maximumBytes,
      shouldForward,
      stderrState,
    ),
  ];
  const reportProgress = progressReporter(
    processStartedAt,
    stdoutState,
    stderrState,
  );
  const heartbeat = setInterval(() => {
    syncRunEvidence(status, stdoutState, stderrState);
    writeStatus(artifacts.statusPath, status);
    reportProgress();
  }, settings.heartbeatMilliseconds);
  heartbeat.unref();

  await supervisedShell.waitForShell();
  let result: Awaited<ReturnType<typeof supervisedShell.finish>>;
  let drainedNaturally = false;
  try {
    drainedNaturally = await waitForCaptureDrain(
      captures,
      settings.drainMilliseconds,
    );
  } finally {
    try {
      result = await supervisedShell.finish();
      await finishCaptures(captures);
      completeRun(status, {
        exitCode: result.exitCode,
        signal: result.signal,
        drainedNaturally,
        cleanup: result.cleanup,
      });
      syncRunEvidence(status, stdoutState, stderrState);
      clearInterval(heartbeat);
      closeRunArtifacts(artifacts);
      writeStatus(artifacts.statusPath, status);
    } finally {
      supervisedShell.close();
    }
  }

  reportProgress();
  if (!shouldForward && artifacts.available && artifacts.directory) {
    renderRetainedOutput(artifacts.directory, status, settings.inlineBytes);
  }
  renderCompletion(status, processStartedAt);
  return result.exitCode;
}
