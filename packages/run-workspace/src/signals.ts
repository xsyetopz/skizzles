import process from "node:process";
import { RunWorkspaceAbortedError } from "./aborted.ts";

interface SignalTarget {
  abort: (error: RunWorkspaceAbortedError) => void;
}

type HandledSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

const targets = new Set<SignalTarget>();
const listeners = new Map<HandledSignal, () => void>();

function supportedSignals(): readonly HandledSignal[] {
  if (process.platform === "win32") return ["SIGINT", "SIGTERM"];
  return ["SIGHUP", "SIGINT", "SIGTERM"];
}

function install(): void {
  if (listeners.size > 0) return;
  for (const signal of supportedSignals()) {
    const listener = (): void => {
      const error = new RunWorkspaceAbortedError(
        `Run workspace interrupted by ${signal}`,
      );
      for (const target of [...targets]) target.abort(error);
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
}

function uninstall(): void {
  if (targets.size > 0) return;
  for (const [signal, listener] of listeners) process.off(signal, listener);
  listeners.clear();
}

export function coordinateSignals(target: SignalTarget): () => void {
  targets.add(target);
  install();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    targets.delete(target);
    uninstall();
  };
}
