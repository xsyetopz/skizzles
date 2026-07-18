export type StreamName = "stdout" | "stderr";

export type SupervisedSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface StreamCaptureState {
  observedBytes: number;
  storedBytes: number;
  truncated: boolean;
  finished: boolean;
  retainedSha256: import("node:crypto").Hash;
}

export interface RunSettings {
  root: string;
  maximumBytes: number;
  maximumDiskBytes: number;
  heartbeatMilliseconds: number;
  drainMilliseconds: number;
  inlineBytes: number;
  signalGraceMilliseconds: number;
}
