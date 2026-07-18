export type StreamName = "stdout" | "stderr";

export type SupervisedSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export type RunStatus = {
  id: string;
  command: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  signal?: string;
  shell: string;
  stdoutObservedBytes: number;
  stderrObservedBytes: number;
  stdoutStoredBytes: number;
  stderrStoredBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  artifactCapture: "active" | "unavailable";
  drainIncomplete: boolean;
};

export type StreamCaptureState = {
  observedBytes: number;
  storedBytes: number;
  truncated: boolean;
  finished: boolean;
};

export type RunSettings = {
  root: string;
  maximumBytes: number;
  maximumDiskBytes: number;
  heartbeatMilliseconds: number;
  drainMilliseconds: number;
  inlineBytes: number;
  signalGraceMilliseconds: number;
};
