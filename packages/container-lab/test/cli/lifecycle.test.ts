import { afterEach, describe, expect, test } from "bun:test";
import {
  createCliFixtureScope,
  drain,
  join,
  ownerKey,
  process,
  processExists,
  readdir,
  readFile,
  runCommand,
  waitForProcessExit,
  waitForPublishedPid,
  withFileLock,
  writeFile,
} from "./support.ts";

const fixtures = createCliFixtureScope();
const { attachedFixture, spawnRun, trackTemporaryPath } = fixtures;
afterEach(fixtures.cleanup);

describe("CLI attached process lifecycle", () => {
  it("run streams before exit and propagates the attached exit code without a JSON footer", async () => {
    const fixture = await attachedFixture();
    const child = spawnRun(fixture, { FAKE_EXIT: "23" });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("early-output");
    expect(await child.exited).toBe(23);
    expect(await drain(reader)).not.toContain('{"');
    expect(await new Response(child.stderr).text()).toContain("early-error");
  });

  it("SIGINT performs exact attached process-group cleanup and exits 130", async () => {
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

  it("SIGTERM performs exact attached process-group cleanup and exits 143", async () => {
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

  it("timeout performs exact attached process-group cleanup and exits 124", async () => {
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

  it("fixture cleanup rejects a current-process PID marker without signaling it or deleting evidence", async () => {
    const isolated = createCliFixtureScope();
    const fixture = await isolated.attachedFixture();
    trackTemporaryPath(fixture.root);
    await writeFile(fixture.pidPath, String(process.pid));
    await writeFile(
      fixture.leaderIdentityPath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processGroup: process.pid,
        token: fixture.testToken,
      }),
    );

    await expect(isolated.cleanup()).rejects.toThrow(
      "Stale or reused attached process identity",
    );
    expect(processExists(process.pid)).toBe(true);
    expect(await readdir(fixture.root)).toContain("run.pid");
    expect(await Bun.file(fixture.leaderIdentityPath).exists()).toBe(true);
  });

  it("fixture cleanup reaps its exact fake process group after a caught assertion path", async () => {
    const isolated = createCliFixtureScope();
    const fixture = await isolated.attachedFixture();
    trackTemporaryPath(fixture.root);
    const child = isolated.spawnRun(fixture);
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "early-output",
    );
    const pid = await waitForPublishedPid(fixture.pidPath);
    const descendant = await waitForPublishedPid(fixture.descendantPath);
    let assertionObserved = false;
    try {
      expect("intentional assertion path").toBe("unreachable");
    } catch {
      assertionObserved = true;
    } finally {
      await isolated.cleanup();
    }

    expect(assertionObserved).toBe(true);
    expect(processExists(pid)).toBe(false);
    expect(processExists(descendant)).toBe(false);
    await expect(readdir(fixture.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("SIGINT cancels promptly while waiting for another attached activity", async () => {
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
      Bun.sleep(2000).then(() => -1),
    ]);
    gate.resolve();
    await held;
    expect(exit).toBe(130);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await Bun.file(fixture.pidPath).exists()).toBe(false);
  });

  it("LaunchAgent uses absolute Bun and reaper paths and is valid plist XML", async () => {
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
