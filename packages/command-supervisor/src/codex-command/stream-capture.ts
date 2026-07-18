import { writeSync } from "node:fs";
import process from "node:process";
import type { StreamCaptureState, StreamName } from "./types.ts";

export type StreamCapture = {
  done: Promise<void>;
  cancel: () => void;
};

export function emptyCaptureState(): StreamCaptureState {
  return {
    observedBytes: 0,
    storedBytes: 0,
    truncated: false,
    finished: false,
  };
}

function forwardChunk(streamName: StreamName, chunk: Uint8Array): void {
  (streamName === "stdout" ? process.stdout : process.stderr).write(chunk);
}

function retainChunk(
  artifact: number,
  chunk: Uint8Array,
  maximumBytes: number,
  state: StreamCaptureState,
): void {
  const remaining = maximumBytes - state.storedBytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const stored = chunk.subarray(0, remaining);
  try {
    const written = writeSync(artifact, stored);
    state.storedBytes += written;
    if (written !== chunk.length) {
      state.truncated = true;
    }
  } catch {
    state.truncated = true;
  }
}

function consumeChunk(
  streamName: StreamName,
  chunk: Uint8Array,
  artifact: number | undefined,
  maximumBytes: number,
  forward: boolean,
  state: StreamCaptureState,
): void {
  state.observedBytes += chunk.length;
  if (forward) {
    forwardChunk(streamName, chunk);
  }
  if (artifact !== undefined) {
    retainChunk(artifact, chunk, maximumBytes, state);
  }
}

export function captureStream(
  stream: ReadableStream<Uint8Array> | null,
  streamName: StreamName,
  artifact: number | undefined,
  maximumBytes: number,
  forward: boolean,
  state: StreamCaptureState,
): StreamCapture {
  if (!stream) {
    state.finished = true;
    return { done: Promise.resolve(), cancel: () => undefined };
  }
  const reader = stream.getReader();
  let cancelled = false;
  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        if (cancelled) {
          break;
        }
        consumeChunk(
          streamName,
          next.value,
          artifact,
          maximumBytes,
          forward,
          state,
        );
      }
    } catch {
      state.truncated = true;
    } finally {
      state.finished = true;
      reader.releaseLock();
    }
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      reader.cancel().catch(() => undefined);
    },
  };
}

export function printCaptured(label: string, content: string): void {
  if (!content) {
    return;
  }
  process.stdout.write(`[codex-command] ${label}:\n${content}`);
  if (!content.endsWith("\n")) {
    process.stdout.write("\n");
  }
}
