import { afterEach, describe, expect, test } from "bun:test";
import {
  ContainerLabService,
  createLabServiceFixtureScope,
  PassThrough,
  RecordingDocker,
  readLab,
  rm,
  TerminatingDocker,
} from "./support.ts";

const fixtures = createLabServiceFixtureScope();
const { durableFixture } = fixtures;
afterEach(fixtures.cleanup);

describe("attached lab commands", () => {
  it("streams an attached argv run and returns its exact exit status", async () => {
    const fixture = await durableFixture("thread-run", "ready", true);
    const docker = new RecordingDocker();
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      docker,
    );
    let stdout = "";
    let stderr = "";
    let stdin = "";
    const input = new PassThrough();
    const running = service.run(
      fixture.lab.id,
      ["printf", "%s", "hello world"],
      ".",
      {},
      30,
      {
        stdout: (chunk) => {
          stdout += chunk;
        },
        stderr: (chunk) => {
          stderr += chunk;
        },
        stdin: input,
      },
    );
    const child = await docker.waitForChildSpawn();
    child.stdin.on("data", (chunk) => {
      stdin += chunk;
    });
    input.write("interactive-input\n");
    (child.stdout as PassThrough).write("early\n");
    (child.stderr as PassThrough).write("warning\n");
    expect(stdout).toBe("early\n");
    expect(stderr).toBe("warning\n");
    expect(stdin).toBe("interactive-input\n");
    Object.assign(child, { exitCode: 23 });
    child.emit("close", 23);
    expect(await running).toBe(23);
    expect(docker.calls.find((call) => call.includes("exec"))).toContain(
      "hello world",
    );
  });

  it("an already-aborted run never launches a container process", async () => {
    const fixture = await durableFixture("thread-pre-abort", "ready", true);
    const docker = new RecordingDocker();
    const controller = new AbortController();
    controller.abort("SIGINT");
    expect(
      await new ContainerLabService(fixture.owner, fixture.roots, docker).run(
        fixture.lab.id,
        ["true"],
        ".",
        {},
        30,
        { stdout: () => undefined, stderr: () => undefined },
        controller.signal,
      ),
    ).toBe(130);
    expect(docker.child).toBeUndefined();
  });

  it("run request validation precedes durable-state reconciliation", async () => {
    const fixture = await durableFixture(
      "thread-invalid-run-order",
      "ready",
      true,
    );
    await rm(fixture.lab.runtimeRoot, { recursive: true, force: true });
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      new RecordingDocker(),
    );

    await expect(
      service.run(fixture.lab.id, [], ".", {}, 30, {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).rejects.toThrow("run argv must contain 1..256 bounded arguments");
    expect(
      (await readLab(fixture.roots, fixture.owner, fixture.lab.id)).state,
    ).toBe("ready");
  });

  it("SIGTERM after launch terminates the exact attached run and returns 143", async () => {
    const fixture = await durableFixture("thread-term-run", "ready", true);
    const docker = new TerminatingDocker();
    const controller = new AbortController();
    const running = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      docker,
    ).run(
      fixture.lab.id,
      ["sleep", "100"],
      ".",
      {},
      0,
      { stdout: () => undefined, stderr: () => undefined },
      controller.signal,
    );
    await docker.waitForChildSpawn();

    controller.abort("SIGTERM");

    expect(await running).toBe(143);
    expect(
      docker.calls.some((args) =>
        args.some(
          (arg) =>
            arg.includes("codex-container-lab-termination:") &&
            arg.includes("kill -TERM"),
        ),
      ),
    ).toBe(true);
  });
});
