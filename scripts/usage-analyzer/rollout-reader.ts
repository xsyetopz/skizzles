import { asObject, type JsonObject } from "./usage.ts";

async function* lines(path: string): AsyncGenerator<string> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      yield pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

function parseEvent(line: string): JsonObject | undefined {
  if (!line.trim()) return undefined;
  try {
    return asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export async function* readEvents(path: string): AsyncGenerator<JsonObject> {
  for await (const line of lines(path)) {
    const event = parseEvent(line);
    if (event) yield event;
  }
}
