import type { StreamCapture } from "./stream-capture.ts";

const captureCancellationMilliseconds = 25;

export function waitForCaptureDrain(
  captures: readonly StreamCapture[],
  drainMilliseconds: number,
): Promise<boolean> {
  const allDone = Promise.all(captures.map((capture) => capture.done));
  return Promise.race([
    allDone.then(() => true),
    Bun.sleep(drainMilliseconds).then(() => false),
  ]);
}

export async function finishCaptures(
  captures: readonly StreamCapture[],
): Promise<void> {
  const allDone = Promise.all(captures.map((capture) => capture.done));
  const finished = await Promise.race([
    allDone.then(() => true),
    Bun.sleep(captureCancellationMilliseconds).then(() => false),
  ]);
  if (!finished) {
    for (const capture of captures) {
      capture.cancel();
    }
    await Promise.race([allDone, Bun.sleep(captureCancellationMilliseconds)]);
  }
}
