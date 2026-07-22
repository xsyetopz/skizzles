import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import process from "node:process";
import type { StreamCaptureState, StreamName } from "./contract.ts";

export type StreamCapture = {
  done: Promise<void>;
  cancel: () => void;
};

export type MemoryStreamCapture = StreamCapture & {
  bytes: () => Uint8Array;
};

export function emptyCaptureState(): StreamCaptureState {
  return {
    observedBytes: 0,
    storedBytes: 0,
    truncated: false,
    finished: false,
    retainedSha256: createHash("sha256"),
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
    state.retainedSha256.update(stored.subarray(0, written));
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
  return consumeStream(stream, state, (chunk) => {
    consumeChunk(streamName, chunk, artifact, maximumBytes, forward, state);
  });
}

function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  state: StreamCaptureState,
  consume: (chunk: Uint8Array) => void,
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
        consume(next.value);
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

export function captureStreamBytes(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  state: StreamCaptureState,
  onLimitExceeded: () => void,
): MemoryStreamCapture {
  const chunks: Uint8Array[] = [];
  let limitReported = false;
  const capture = consumeStream(stream, state, (chunk) => {
    state.observedBytes += chunk.length;
    const remaining = maximumBytes - state.storedBytes;
    if (remaining > 0) {
      const retained = Uint8Array.from(chunk.subarray(0, remaining));
      chunks.push(retained);
      state.storedBytes += retained.length;
      state.retainedSha256.update(retained);
    }
    if (state.observedBytes > maximumBytes) {
      state.truncated = true;
      if (!limitReported) {
        limitReported = true;
        onLimitExceeded();
      }
    }
  });
  return {
    ...capture,
    bytes: () => {
      const content = new Uint8Array(state.storedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
      }
      return content;
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
