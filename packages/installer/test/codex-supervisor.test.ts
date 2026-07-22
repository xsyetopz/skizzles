import { describe, expect, it } from "bun:test";
import { lstat, readFile } from "node:fs/promises";
import process from "node:process";
import { create } from "@skizzles/run-workspace";
import {
  signalOwnedSupervisor,
  spawnRpcSupervisor,
} from "../src/codex-config/supervisor.ts";

describe("Codex app-server supervisor ownership", () => {
  it("kills a TERM-resistant inherited-pipe descendant before root deletion", async () => {
    if (process.platform === "win32") return;
    const workspace = await create({ gracefulStopMs: 20, forceStopMs: 20 });
    const root = workspace.path();
    const record = workspace.path("descendant.pid");
    const tool = [
      'import { writeFile } from "node:fs/promises";',
      'import process from "node:process";',
      "const descendant = Bun.spawn([process.execPath, '--eval', `process.on('SIGTERM', () => undefined); console.log('held stdout'); console.error('held stderr'); setInterval(() => undefined, 1000)`], { stdout: 'inherit', stderr: 'inherit' });",
      `await writeFile(${JSON.stringify(record)}, String(descendant.pid));`,
      "await Bun.sleep(75);",
      "process.exit(0);",
    ].join("\n");
    const supervisor = spawnRpcSupervisor([process.execPath, "--eval", tool], {
      ...process.env,
    });
    workspace.registerChild(supervisor.scope);
    await supervisor.waitUntilReady();
    expect(await supervisor.waitForToolExit(2000)).toBeTrue();
    const descendant = Number(await readFile(record, "utf8"));
    expect(processExists(descendant)).toBeTrue();
    await supervisor.scope.forceStop();
    await supervisor.scope.waitForExit();
    expect(processExists(descendant)).toBeFalse();
    expect((await workspace.close()).state).toBe("deleted");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("does not signal a recycled PGID after unexpected supervisor exit", async () => {
    if (process.platform === "win32") return;
    let signals = 0;
    expect(
      signalOwnedSupervisor(true, 42, "SIGKILL", (() => {
        signals += 1;
        return true;
      }) as typeof process.kill),
    ).toBeFalse();
    expect(signals).toBe(0);

    const workspace = await create({ gracefulStopMs: 20, forceStopMs: 20 });
    const root = workspace.path();
    const record = workspace.path("survivors.txt");
    const shell = [
      `echo "$$" > ${shellQuote(record)}`,
      `(trap '' TERM HUP; while :; do sleep 1; done) & echo "$!" >> ${shellQuote(
        record,
      )}`,
      "sleep 0.1",
      `kill -KILL "$PPID"`,
      "wait",
    ].join("; ");
    const supervisor = spawnRpcSupervisor(["/bin/sh", "-c", shell], {
      ...process.env,
    });
    workspace.registerChild(supervisor.scope);
    await supervisor.waitUntilReady();
    await supervisor.process.exited;
    await expect(supervisor.scope.waitForExit()).rejects.toThrow(
      "process scope exit could not be verified",
    );
    expect(await lstat(root)).toBeDefined();
    const survivors = (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    for (const pid of survivors) {
      if (processExists(pid)) process.kill(pid, "SIGKILL");
    }
    await waitForExit(survivors);
    expect((await workspace.close()).state).toBe("deleted");
  }, 10_000);
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function waitForExit(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 2000;
  while (pids.some(processExists) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  if (pids.some(processExists)) {
    throw new Error("fixture survivor did not exit");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
