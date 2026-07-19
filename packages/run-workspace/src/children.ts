import type { ChildCleanup, OwnedChild } from "./contract.ts";
import type { Runtime } from "./platform.ts";

interface ChildAttempt {
  readonly child: OwnedChild;
  exited: boolean;
  forced: boolean;
  forceFailed: boolean;
  wait: Promise<void>;
}

function observeExit(attempt: ChildAttempt): Promise<void> {
  let exit: Promise<void>;
  try {
    exit = attempt.child.waitForExit();
  } catch {
    return Promise.resolve();
  }
  return exit.then(
    () => {
      attempt.exited = true;
    },
    () => undefined,
  );
}

function childError(forceFailed: boolean): NonNullable<ChildCleanup["error"]> {
  if (forceFailed) return "FORCE_STOP_FAILED";
  return "EXIT_UNCONFIRMED";
}

async function waitForChildren(
  attempts: readonly ChildAttempt[],
  milliseconds: number,
  runtime: Runtime,
  escalation?: Promise<void>,
): Promise<void> {
  const waiting = Promise.all(attempts.map((attempt) => attempt.wait)).then(
    () => undefined,
  );
  const deadline = runtime.deadline(milliseconds);
  const contenders: Promise<void>[] = [waiting, deadline.elapsed];
  if (escalation !== undefined) contenders.push(escalation);
  try {
    await Promise.race(contenders);
  } finally {
    deadline.cancel();
  }
}

function childReport(attempt: ChildAttempt): ChildCleanup {
  const base = {
    label: attempt.child.label,
    stopped: attempt.exited,
    forced: attempt.forced,
  };
  const withPid =
    attempt.child.pid === undefined
      ? base
      : { ...base, pid: attempt.child.pid };
  if (attempt.exited) return withPid;
  return { ...withPid, error: childError(attempt.forceFailed) };
}

export interface StopOptions {
  readonly children: readonly OwnedChild[];
  readonly runtime: Runtime;
  readonly gracefulStopMs: number;
  readonly forceStopMs: number;
  readonly escalation: Promise<void>;
}

export async function stopChildren(
  options: StopOptions,
): Promise<readonly ChildCleanup[]> {
  const attempts: ChildAttempt[] = [...options.children]
    .reverse()
    .map((child) => ({
      child,
      exited: false,
      forced: false,
      forceFailed: false,
      wait: Promise.resolve(),
    }));
  for (const attempt of attempts) {
    attempt.wait = observeExit(attempt);
    try {
      Promise.resolve(attempt.child.requestStop()).catch(() => undefined);
    } catch {
      // A synchronous request failure proceeds directly to bounded forcing.
    }
  }
  await waitForChildren(
    attempts,
    options.gracefulStopMs,
    options.runtime,
    options.escalation,
  );
  const unresolved = attempts.filter((attempt) => !attempt.exited);
  for (const attempt of unresolved) {
    attempt.forced = true;
    try {
      Promise.resolve(attempt.child.forceStop()).catch(() => {
        attempt.forceFailed = true;
      });
    } catch {
      attempt.forceFailed = true;
    }
    attempt.wait = observeExit(attempt);
  }
  await waitForChildren(unresolved, options.forceStopMs, options.runtime);
  return attempts.map(childReport);
}
