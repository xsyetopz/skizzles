// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, it } from "bun:test";
import { lstat } from "node:fs/promises";
import process from "node:process";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe("signal coordination", () => {
  it("aborts and cleans the active workspace on a real Unix signal", async () => {
    if (process.platform === "win32") return;
    const source = [
      'import { create } from "./src/api.ts";',
      "const workspace = await create({ handleSignals: true, gracefulStopMs: 20, forceStopMs: 20 });",
      "console.log(workspace.path());",
      "workspace.signal.addEventListener('abort', async () => {",
      "  const report = await workspace.close();",
      "  process.exit(report.state === 'deleted' ? 143 : 2);",
      "}, { once: true });",
      "setInterval(() => undefined, 1000);",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", source], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    const root = new TextDecoder().decode(first.value).trim();
    expect(root).not.toBe("");
    process.kill(child.pid, "SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await exists(root)).toBeFalse();
  }, 10_000);

  it("escalates registered children on a repeated Unix signal", async () => {
    if (process.platform === "win32") return;
    const source = [
      'import { create } from "./src/api.ts";',
      "let release = () => undefined;",
      "const exited = new Promise((resolve) => { release = resolve; });",
      "const workspace = await create({ handleSignals: true, gracefulStopMs: 5000, forceStopMs: 100 });",
      "workspace.registerChild({ label: 'scope', requestStop: () => undefined, forceStop: release, waitForExit: () => exited });",
      "console.log(workspace.path());",
      "workspace.signal.addEventListener('abort', async () => {",
      "  const report = await workspace.close();",
      "  process.exit(report.state === 'deleted' && report.children[0]?.forced ? 143 : 2);",
      "}, { once: true });",
      "setInterval(() => undefined, 1000);",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", source], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    await reader.read();
    process.kill(child.pid, "SIGTERM");
    await Bun.sleep(20);
    process.kill(child.pid, "SIGTERM");
    expect(await child.exited).toBe(143);
  }, 10_000);
});
