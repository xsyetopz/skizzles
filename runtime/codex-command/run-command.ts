import { join } from "node:path";
import {
  artifactContents,
  artifactTail,
  closeRunArtifacts,
  createRunId,
  prepareRunArtifacts,
  writeStatus,
} from "./run-artifacts.ts";
import { commandShell, loadRunSettings } from "./settings.ts";
import { spawnSupervisedShell } from "./shell-process.ts";
import {
  captureStream,
  emptyCaptureState,
  printCaptured,
  type StreamCapture,
} from "./stream-capture.ts";
import type { RunStatus, StreamCaptureState } from "./types.ts";

function syncStreamStatus(
  status: RunStatus,
  stdout: StreamCaptureState,
  stderr: StreamCaptureState,
): void {
  status.stdoutObservedBytes = stdout.observedBytes;
  status.stderrObservedBytes = stderr.observedBytes;
  status.stdoutStoredBytes = stdout.storedBytes;
  status.stderrStoredBytes = stderr.storedBytes;
  status.stdoutTruncated = stdout.truncated;
  status.stderrTruncated = stderr.truncated;
}

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
    const seconds = Math.floor((performance.now() - startedAt) / 1_000);
    console.log(
      `| ${seconds}s | ${stdout.observedBytes}B | ${stderr.observedBytes}B |`,
    );
    lastReportedStdoutBytes = stdout.observedBytes;
    lastReportedStderrBytes = stderr.observedBytes;
  };
}

async function drainCaptures(
  captures: readonly StreamCapture[],
  drainMilliseconds: number,
): Promise<boolean> {
  const allDone = Promise.all(captures.map((capture) => capture.done));
  const drained = await Promise.race([
    allDone.then(() => true),
    Bun.sleep(drainMilliseconds).then(() => false),
  ]);
  for (const capture of captures) capture.cancel();
  await Promise.race([allDone, Bun.sleep(25)]);
  return !drained;
}

function renderRetainedOutput(
  directory: string,
  status: RunStatus,
  inlineBytes: number,
): void {
  const combinedBytes = status.stdoutObservedBytes + status.stderrObservedBytes;
  const printFullOutput =
    combinedBytes <= inlineBytes &&
    !status.stdoutTruncated &&
    !status.stderrTruncated;
  if (printFullOutput) {
    printCaptured("stdout", artifactContents(join(directory, "stdout.log")));
    printCaptured("stderr", artifactContents(join(directory, "stderr.log")));
    return;
  }
  printCaptured("stdout tail", artifactTail(join(directory, "stdout.log")));
  printCaptured("stderr tail", artifactTail(join(directory, "stderr.log")));
}

function renderCompletion(status: RunStatus, processStartedAt: number): void {
  if (status.stdoutTruncated || status.stderrTruncated) {
    console.log(
      `[codex-command] retained out=${status.stdoutStoredBytes}/${status.stdoutObservedBytes}B err=${status.stderrStoredBytes}/${status.stderrObservedBytes}B`,
    );
  }
  const outcome = status.signal
    ? `signal ${status.signal}`
    : `exit ${status.exitCode ?? "unknown"}`;
  const incomplete = status.drainIncomplete ? " drain-incomplete" : "";
  const elapsedSeconds = Math.floor(
    (performance.now() - processStartedAt) / 1_000,
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
  const status: RunStatus = {
    id,
    command: script,
    startedAt: new Date().toISOString(),
    shell,
    stdoutObservedBytes: 0,
    stderrObservedBytes: 0,
    stdoutStoredBytes: 0,
    stderrStoredBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    artifactCapture: artifacts.available ? "active" : "unavailable",
    drainIncomplete: false,
  };
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
    status.completedAt = new Date().toISOString();
    status.exitCode = 127;
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
    syncStreamStatus(status, stdoutState, stderrState);
    writeStatus(artifacts.statusPath, status);
    reportProgress();
  }, settings.heartbeatMilliseconds);
  heartbeat.unref();

  await supervisedShell.waitForShell();
  let result: Awaited<ReturnType<typeof supervisedShell.finish>>;
  try {
    status.drainIncomplete = await drainCaptures(
      captures,
      settings.drainMilliseconds,
    );
  } finally {
    try {
      result = await supervisedShell.finish();
      status.completedAt = new Date().toISOString();
      status.exitCode = result.exitCode;
      if (result.signal !== undefined) status.signal = result.signal;
      syncStreamStatus(status, stdoutState, stderrState);
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
