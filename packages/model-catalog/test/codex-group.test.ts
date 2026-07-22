import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { RunWorkspace } from "@skizzles/run-workspace";
import {
  clientVersion,
  CodexChildError,
  type CodexRuntime,
} from "../src/codex-child.ts";
import {
  codexSupervisorGroup,
  signalOwnedCodexSupervisor,
} from "../src/codex-group.ts";

function subprocess(
  exited: Promise<number>,
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return {
    pid: 4242,
    exitCode: null,
    exited,
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
  } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
}

it("observed supervisor exit permanently disables numeric group signals", () => {
  let calls = 0;
  const kill = (() => {
    calls += 1;
    return true;
  }) as typeof process.kill;

  expect(signalOwnedCodexSupervisor(true, 4242, "SIGKILL", kill)).toBe(false);
  expect(calls).toBe(0);
});

it("graceful signal failure still attempts forced termination", async () => {
  const exit = Promise.withResolvers<number>();
  const signals: NodeJS.Signals[] = [];
  const kill = ((_pid: number, signal: NodeJS.Signals) => {
    signals.push(signal);
    if (signal === "SIGTERM") throw new Error("graceful denied");
    exit.resolve(137);
    return true;
  }) as typeof process.kill;

  await codexSupervisorGroup(subprocess(exit.promise), "test", kill).stopWithin(
    1,
  );

  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

it("forced signal failure rejects with both signal errors", async () => {
  const signals: NodeJS.Signals[] = [];
  const kill = ((_pid: number, signal: NodeJS.Signals) => {
    signals.push(signal);
    throw new Error(`${signal} denied`);
  }) as typeof process.kill;

  const cleanup = codexSupervisorGroup(
    subprocess(new Promise<number>(() => undefined)),
    "test",
    kill,
  ).stopWithin(1);

  await expect(cleanup).rejects.toBeInstanceOf(AggregateError);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

it("cleanup signal failure cannot leave a Codex command wait unbounded", async () => {
  const root = await mkdtemp(
    join(process.env["TMPDIR"] ?? "/tmp", "codex-group-"),
  );
  const controller = new AbortController();
  const child = subprocess(new Promise<number>(() => undefined));
  const runtime: CodexRuntime = {
    platform: process.platform,
    kill: (() => {
      throw new Error("signal denied");
    }) as typeof process.kill,
    spawn: () => child,
  };
  const workspace = {
    signal: controller.signal,
    path: (...parts: readonly string[]) => join(root, ...parts),
    registerChild: () => undefined,
  } as unknown as RunWorkspace;

  try {
    const result = await Promise.race([
      clientVersion(
        workspace,
        process.execPath,
        {
          timeoutMs: 1,
          terminationGraceMs: 1,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
        },
        runtime,
      ).then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      Bun.sleep(250).then(() => "deadline" as const),
    ]);

    expect(result).toBeInstanceOf(CodexChildError);
    expect(result).not.toBe("deadline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
