import process from "node:process";
import type { SupervisedSignal } from "./contract.ts";
import {
  processTreeExists,
  signalProcessTree,
  terminateProcessTree,
  waitForProcessTreeExit,
} from "./process-tree.ts";

type ShellSubprocess = Bun.Subprocess<"inherit", "pipe", "pipe">;

export type ShellCleanupOutcome = "not-required" | "terminated" | "killed";

export type SupervisedShell = {
  child: ShellSubprocess;
  waitForShell: () => Promise<number>;
  finish: () => Promise<{
    exitCode: number;
    signal: SupervisedSignal | undefined;
    cleanup: ShellCleanupOutcome;
  }>;
  close: () => void;
};

const supervisedSignals: readonly SupervisedSignal[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
];

const signalExitCodes: Readonly<Record<SupervisedSignal, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export function spawnSupervisedShell(
  shell: string,
  script: string,
  signalGraceMilliseconds: number,
): SupervisedShell {
  const child: ShellSubprocess = Bun.spawn([shell, "-c", script], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let receivedSignal: SupervisedSignal | undefined;
  let shellExited = false;
  let signalAfterShellExit = false;
  let shellExitCode: number | undefined;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  let escalationComplete = false;
  let escalated = false;
  let resolveEscalation: () => void = () => undefined;
  const escalation = new Promise<void>((resolve) => {
    resolveEscalation = resolve;
  });

  const finishEscalation = () => {
    if (escalationComplete) {
      return;
    }
    escalationComplete = true;
    if (escalationTimer) {
      clearTimeout(escalationTimer);
    }
    escalationTimer = undefined;
    resolveEscalation();
  };
  const forceExit = () => {
    escalated = true;
    signalProcessTree(child, "SIGKILL");
    finishEscalation();
  };
  const handleSignal = (signal: SupervisedSignal) => {
    if (receivedSignal !== undefined) {
      forceExit();
      return;
    }
    receivedSignal = signal;
    signalAfterShellExit = shellExited;
    signalProcessTree(child, signal);
    escalationTimer = setTimeout(forceExit, signalGraceMilliseconds);
    escalationTimer.unref();
  };
  const handlers = new Map<SupervisedSignal, () => void>();
  for (const signal of supervisedSignals) {
    const handler = handleSignal.bind(undefined, signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  const removeHandlers = () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };

  const settleReceivedSignal = async (): Promise<ShellCleanupOutcome> => {
    if (receivedSignal === undefined) {
      return "not-required";
    }
    if (processTreeExists(child)) {
      const exitedBeforeEscalation = await Promise.race([
        waitForProcessTreeExit(child, signalGraceMilliseconds + 25),
        escalation.then(() => false),
      ]);
      if (exitedBeforeEscalation) {
        finishEscalation();
      } else {
        await escalation;
      }
    } else {
      finishEscalation();
    }
    await waitForProcessTreeExit(child, 500);
    return escalated ? "killed" : "terminated";
  };

  const settleNormalCompletion = async (): Promise<ShellCleanupOutcome> =>
    terminateProcessTree(child, signalGraceMilliseconds);

  return {
    child,
    waitForShell: async () => {
      shellExitCode = await child.exited;
      shellExited = true;
      return shellExitCode;
    },
    finish: async () => {
      await Bun.sleep(0);
      const cleanup =
        receivedSignal === undefined
          ? await settleNormalCompletion()
          : await settleReceivedSignal();
      const signal = receivedSignal;
      const exitCode =
        signal !== undefined && signalAfterShellExit
          ? signalExitCodes[signal]
          : (shellExitCode ?? (await child.exited));
      return { exitCode, signal, cleanup };
    },
    close: () => {
      finishEscalation();
      removeHandlers();
    },
  };
}
