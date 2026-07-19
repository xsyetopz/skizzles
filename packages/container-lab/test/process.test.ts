// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { assertProcessPlatform } from "../src/process/platform.ts";
import { runCommand } from "../src/process.ts";
import {
  createProcessFixtureScope,
  observeGroupAbsence,
  stubbornGroupScript,
} from "./process-fixture.ts";

const fixtures = createProcessFixtureScope();
afterEach(fixtures.cleanup);

describe("runCommand result contracts", () => {
  it("bounds captured output", async () => {
    const result = await runCommand("/bin/sh", ["-c", "printf 123456789"], {
      maxOutputBytes: 4,
    });
    expect(result.stdout.toString()).toBe("1234");
  });

  it("rejects stdout overflow when complete output is required", async () => {
    const fixture = await fixtures.start(
      stubbornGroupScript("printf 123456789; wait"),
      {
        maxOutputBytes: 4,
        rejectOnOutputLimit: true,
      },
    );
    const identity = await fixtures.captureGroup(fixture.marker);
    await writeFile(fixture.release, "release", { mode: 0o600 });
    await expect(fixture.completion).rejects.toThrow(
      "/bin/sh stdout exceeded 4 byte output limit",
    );
    expect(await observeGroupAbsence(identity)).toEqual([true, true, true]);
  });

  it("rejects stderr overflow even when command failure is allowed", async () => {
    await expect(
      runCommand("/bin/sh", ["-c", "printf 123456789 >&2; sleep 30"], {
        allowFailure: true,
        maxOutputBytes: 4,
        rejectOnOutputLimit: true,
      }),
    ).rejects.toThrow("/bin/sh stderr exceeded 4 byte output limit");
  });

  it("applies the complete-output cap independently to stdout and stderr", async () => {
    await expect(
      runCommand("/bin/sh", ["-c", "printf 1234; printf 5678 >&2"], {
        maxOutputBytes: 4,
        rejectOnOutputLimit: true,
      }),
    ).resolves.toEqual({
      code: 0,
      stdout: Buffer.from("1234"),
      stderr: Buffer.from("5678"),
    });
  });

  it("reports failures", async () => {
    const fixture = await fixtures.start(
      stubbornGroupScript("echo nope >&2; exit 7"),
    );
    const identity = await fixtures.captureGroup(fixture.marker);
    await writeFile(fixture.release, "release", { mode: 0o600 });
    await expect(fixture.completion).rejects.toThrow("failed (7): nope");
    expect(await observeGroupAbsence(identity)).toEqual([true, true, true]);
  });

  it("rejects an already-aborted signal before spawning", async () => {
    const fixture = await fixtures.start(
      'printf created > "$TMPDIR/pre-abort-sentinel"; sleep 1',
      { signal: AbortSignal.abort() },
    );
    await expect(fixture.completion).rejects.toThrow("/bin/sh aborted");
    expect(
      await Bun.file(join(fixture.root, "pre-abort-sentinel")).exists(),
    ).toBe(false);
  });

  it("rejects unsupported Windows process dispatch before execution", () => {
    expect(() => assertProcessPlatform("win32", "/bin/sh")).toThrow(
      "/bin/sh requires POSIX process-group ownership; win32 is unsupported",
    );
    expect(() => assertProcessPlatform("darwin", "/bin/sh")).not.toThrow();
  });
});

describe("runCommand POSIX lifecycle", () => {
  it("timeout reaps the exact shell leader and background sleep", async () => {
    const fixture = await fixtures.start(
      'sleep 30 & descendant=$!; printf "%s %s\\n" "$$" "$descendant" > "$TEST_PROCESS_MARKER"; wait',
      { timeoutMs: 100 },
    );
    const identity = await fixtures.captureGroup(fixture.marker);
    await expect(fixture.completion).rejects.toThrow("failed (124)");
    expect(await observeGroupAbsence(identity)).toEqual([true, true, true]);
  });

  it("abort reaps a TERM-resistant leader and descendant", async () => {
    const controller = new AbortController();
    const fixture = await fixtures.start(stubbornGroupScript(), {
      signal: controller.signal,
    });
    const identity = await fixtures.captureGroup(fixture.marker);
    controller.abort();
    await expect(fixture.completion).rejects.toThrow("/bin/sh aborted");
    expect(await observeGroupAbsence(identity)).toEqual([true, true, true]);
  });

  it("leader exit with descendant-held pipes cannot hang or leak", async () => {
    const fixture = await fixtures.start(stubbornGroupScript("exit 0"));
    const identity = await fixtures.captureGroup(fixture.marker);
    await writeFile(fixture.release, "release", { mode: 0o600 });
    await expect(fixture.completion).resolves.toEqual({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    expect(await observeGroupAbsence(identity)).toEqual([true, true, true]);
  });
});

describe("runCommand cleanup failure", () => {
  it("cleanup failure is never reported as command success", async () => {
    const fixture = await fixtures.start(stubbornGroupScript("exit 0"));
    const identity = await fixtures.captureGroup(fixture.marker);
    const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
    if (descriptor === undefined) {
      throw new Error("process.kill descriptor is unavailable");
    }
    Object.defineProperty(process, "kill", {
      ...descriptor,
      value: (pid: number, signal?: string | number): boolean => {
        if (pid === -identity.processGroup && signal === "SIGKILL") {
          throw Object.assign(new Error("injected permission denial"), {
            code: "EPERM",
          });
        }
        return Reflect.apply(descriptor.value, process, [pid, signal]) === true;
      },
    });
    try {
      await writeFile(fixture.release, "release", { mode: 0o600 });
      await expect(fixture.completion).rejects.toThrow(
        "cleanup failed: cannot send SIGKILL",
      );
    } finally {
      Object.defineProperty(process, "kill", descriptor);
    }
  });
});
