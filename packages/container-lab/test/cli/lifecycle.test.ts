// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, test } from "bun:test";
import {
  attachedFixture,
  drain,
  join,
  ownerKey,
  readFile,
  runCommand,
  spawnRun,
  waitForProcessExit,
  waitForPublishedPid,
  withFileLock,
} from "./support.ts";

describe("CLI attached process lifecycle", () => {
  test("run streams before exit and propagates the attached exit code without a JSON footer", async () => {
    const fixture = await attachedFixture();
    const child = spawnRun(fixture, { FAKE_EXIT: "23" });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("early-output");
    expect(await child.exited).toBe(23);
    expect(await drain(reader)).not.toContain('{"');
    expect(await new Response(child.stderr).text()).toContain("early-error");
  });

  test("SIGINT performs exact attached process-group cleanup and exits 130", async () => {
    const fixture = await attachedFixture();
    const child = spawnRun(fixture);
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "early-output",
    );
    const pid = await waitForPublishedPid(fixture.pidPath);
    const descendant = await waitForPublishedPid(fixture.descendantPath);
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    await drain(reader);
    expect(await waitForProcessExit(pid)).toBe(true);
    expect(await waitForProcessExit(descendant)).toBe(true);
  });

  test("SIGTERM performs exact attached process-group cleanup and exits 143", async () => {
    const fixture = await attachedFixture();
    const child = spawnRun(fixture);
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "early-output",
    );
    const pid = await waitForPublishedPid(fixture.pidPath);
    const descendant = await waitForPublishedPid(fixture.descendantPath);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    await drain(reader);
    expect(await waitForProcessExit(pid)).toBe(true);
    expect(await waitForProcessExit(descendant)).toBe(true);
  });

  test("timeout performs exact attached process-group cleanup and exits 124", async () => {
    const fixture = await attachedFixture();
    const child = spawnRun(fixture, {}, 1);
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "early-output",
    );
    const pid = await waitForPublishedPid(fixture.pidPath);
    const descendant = await waitForPublishedPid(fixture.descendantPath);
    expect(await child.exited).toBe(124);
    await drain(reader);
    expect(await waitForProcessExit(pid)).toBe(true);
    expect(await waitForProcessExit(descendant)).toBe(true);
  });

  test("SIGINT cancels promptly while waiting for another attached activity", async () => {
    const fixture = await attachedFixture();
    const activity = join(
      fixture.stateRoot,
      "owners",
      ownerKey(fixture.owner),
      ".locks",
      "activity-lab-1",
    );
    const gate = Promise.withResolvers<void>();
    const held = withFileLock(activity, async () => await gate.promise);
    await Bun.sleep(20);
    const child = spawnRun(fixture);
    await Bun.sleep(100);
    child.kill("SIGINT");
    const exit = await Promise.race([
      child.exited,
      Bun.sleep(2_000).then(() => -1),
    ]);
    gate.resolve();
    await held;
    expect(exit).toBe(130);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await Bun.file(fixture.pidPath).exists()).toBe(false);
  });

  test("LaunchAgent uses absolute Bun and reaper paths and is valid plist XML", async () => {
    const path = join(
      import.meta.dir,
      "..",
      "..",
      "install",
      "com.openai.codex-container-lab-reaper.plist",
    );
    const source = await readFile(path, "utf8");
    expect(source).toContain("<string>__BUN_ABSOLUTE_PATH__</string>");
    expect(source).toContain("<string>__REAPER_ABSOLUTE_PATH__</string>");
    expect(source.indexOf("__BUN_ABSOLUTE_PATH__")).toBeLessThan(
      source.indexOf("__REAPER_ABSOLUTE_PATH__"),
    );
    expect(source).not.toContain("/usr/bin/env");
    expect(
      (await runCommand("/usr/bin/plutil", ["-lint", path])).stdout.toString(),
    ).toContain("OK");
  });
});
