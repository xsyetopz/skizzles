import { afterEach, describe, expect, it } from "bun:test";
import {
  ContainerLabService,
  createLabServiceFixtureScope,
  DestructiveDocker,
  join,
  labManifestPath,
  labsDirectory,
  mkdir,
  ownerDirectory,
  RecordingDocker,
  readFileSync,
  readLab,
  rename,
  replaceLabWithSymlink,
  symlink,
  writeFile,
  writeFileSync,
  writeLab,
} from "./support.ts";

const fixtures = createLabServiceFixtureScope();
const { durableFixture } = fixtures;
afterEach(fixtures.cleanup);

describe("lab cleanup and state trust", () => {
  it("destroy removes exact containers first, then waits for attached activity before filesystem cleanup", async () => {
    const fixture = await durableFixture(
      "thread-destroy-active",
      "ready",
      true,
    );
    const docker = new DestructiveDocker();
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      docker,
    );
    const running = service.run(fixture.lab.id, ["sleep", "100"], ".", {}, 0, {
      stdout: () => undefined,
      stderr: () => undefined,
    });
    await docker.waitForChildSpawn();
    expect(await service.destroyLab(fixture.lab.id)).toEqual({
      labId: fixture.lab.id,
      destroyed: true,
    });
    expect(await running).toBe(137);
    expect(
      docker.calls.some(
        (args) =>
          args[0] === "rm" && args[1] === "-f" && args.includes("container-1"),
      ),
    ).toBe(true);
  });

  it("a tampered runtime path fails closed before destroy touches Docker or outside data", async () => {
    const fixture = await durableFixture("thread-tampered", "failed");
    const sentinel = join(fixture.root, "outside", "sentinel.txt");
    await mkdir(join(fixture.root, "outside"), { recursive: true });
    await writeFile(sentinel, "keep");
    const path = labManifestPath(
      fixture.roots.stateRoot,
      fixture.owner,
      fixture.lab.id,
    );
    const corrupted = JSON.parse(readFileSync(path, "utf8"));
    corrupted.runtimeRoot = join(fixture.root, "outside");
    corrupted.workspace = join(fixture.root, "outside", "workspace");
    writeFileSync(path, JSON.stringify(corrupted));
    const docker = new RecordingDocker();
    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).destroyLab(
        fixture.lab.id,
      ),
    ).rejects.toThrow("invalid lab manifest");
    expect(await Bun.file(sentinel).text()).toBe("keep");
    expect(docker.calls).toEqual([]);
  });

  it("a symlinked owner runtime parent fails closed before cleanup", async () => {
    const fixture = await durableFixture(
      "thread-destroy-symlink",
      "ready",
      true,
    );
    const ownerRuntime = join(fixture.roots.runtimeRoot, fixture.lab.ownerKey);
    const outside = join(fixture.root, "outside-runtime-owner");
    await rename(ownerRuntime, outside);
    await symlink(outside, ownerRuntime, "dir");
    const docker = new RecordingDocker();
    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).destroyLab(
        fixture.lab.id,
      ),
    ).rejects.toThrow("unsafe indirection");
    expect(docker.calls).toEqual([]);
  });

  it("destroy accepts an already-missing runtime but still removes exact state", async () => {
    const fixture = await durableFixture("thread-destroy-missing", "failed");
    const docker = new RecordingDocker();

    expect(
      await new ContainerLabService(
        fixture.owner,
        fixture.roots,
        docker,
      ).destroyLab(fixture.lab.id),
    ).toEqual({ labId: fixture.lab.id, destroyed: true });
    await expect(
      readLab(fixture.roots, fixture.owner, fixture.lab.id),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await new ContainerLabService(
        fixture.owner,
        fixture.roots,
        docker,
      ).destroyLab(fixture.lab.id),
    ).toEqual({ labId: fixture.lab.id, destroyed: false });
  });

  it("a replaced owner state directory fails closed before Docker or outside cleanup", async () => {
    const fixture = await durableFixture(
      "thread-destroy-replaced-state",
      "ready",
      true,
    );
    const ownerState = ownerDirectory(fixture.roots.stateRoot, fixture.owner);
    const outside = join(fixture.root, "outside-owner-state");
    const sentinel = join(outside, "sentinel.txt");
    await rename(ownerState, outside);
    await writeFile(sentinel, "keep");
    await symlink(outside, ownerState, "dir");
    const docker = new RecordingDocker();

    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).destroyLab(
        fixture.lab.id,
      ),
    ).rejects.toThrow("unsafe indirection");
    expect(await Bun.file(sentinel).text()).toBe("keep");
    expect(docker.calls).toEqual([]);
  });

  it("health and status reject a symlinked durable lab file before Docker", async () => {
    for (const operation of ["health", "status"] as const) {
      const fixture = await durableFixture(
        `thread-read-${operation}`,
        "failed",
      );
      await replaceLabWithSymlink(fixture);
      const docker = new RecordingDocker();
      const service = new ContainerLabService(
        fixture.owner,
        fixture.roots,
        docker,
      );

      const result =
        operation === "health"
          ? service.health()
          : service.labStatus(fixture.lab.id);
      await expect(result).rejects.toThrow(
        "lab state file contains unsafe indirection",
      );
      expect(docker.calls).toEqual([]);
    }
  });

  it("provisioning rejects a symlinked durable-state parent before source or Docker access", async () => {
    const fixture = await durableFixture("thread-read-provision", "failed");
    const labs = labsDirectory(fixture.roots.stateRoot, fixture.owner);
    const outside = join(fixture.root, "outside-labs");
    await rename(labs, outside);
    await symlink(outside, labs, "dir");
    const docker = new RecordingDocker();

    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).createLab(
        "new-lab",
        join(fixture.root, "missing-source"),
      ),
    ).rejects.toThrow("lab state directory contains unsafe indirection");
    expect(docker.calls).toEqual([]);
  });

  it("provisioning rejects a symlinked reaped-owner marker parent before source or Docker access", async () => {
    const fixture = await durableFixture("thread-read-marker", "failed");
    const outside = join(fixture.root, "outside-reaped");
    await mkdir(outside);
    await symlink(outside, join(fixture.roots.stateRoot, "reaped"), "dir");
    const docker = new RecordingDocker();

    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).createLab(
        "new-lab",
        join(fixture.root, "missing-source"),
      ),
    ).rejects.toThrow("reaped owner marker parent contains unsafe indirection");
    expect(docker.calls).toEqual([]);
  });

  it("run rejects a symlinked durable lab file before attached execution", async () => {
    const fixture = await durableFixture("thread-read-run", "failed");
    await replaceLabWithSymlink(fixture);
    const docker = new RecordingDocker();

    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).run(
        fixture.lab.id,
        ["true"],
        ".",
        {},
        1,
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toThrow("lab state file contains unsafe indirection");
    expect(docker.calls).toEqual([]);
  });

  it("public lab views omit internal persistence fields", async () => {
    const fixture = await durableFixture("thread-output", "failed");
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      new RecordingDocker(),
    );
    const encoded = JSON.stringify(await service.labStatus(fixture.lab.id));
    for (const forbidden of [
      "ownerKey",
      "runtimeRoot",
      "sourceRoot",
      "composeArgs",
      "manifestPath",
      fixture.lab.ownerKey,
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(Buffer.byteLength(encoded)).toBeLessThan(16 * 1024);
  });

  it("durable runtime validation rejects invalid and overlapping environment names", async () => {
    const fixture = await durableFixture("thread-secret-state", "ready", true);
    const runtime = fixture.lab.runtime;
    if (!runtime) {
      throw new Error("expected ready runtime");
    }
    runtime.config.secretEnvironment = ["BAD-NAME"];
    await expect(writeLab(fixture.roots, fixture.lab)).rejects.toThrow(
      "invalid secret environment",
    );
    runtime.config.secretEnvironment = ["TERM"];
    runtime.config.forwardEnvironment = [];
    runtime.config.composeEnvironment = ["TERM"];
    await expect(writeLab(fixture.roots, fixture.lab)).rejects.toThrow(
      "invalid secret environment",
    );
    runtime.config.composeEnvironment = [];
    runtime.config.forwardEnvironment = ["TERM"];
    await expect(writeLab(fixture.roots, fixture.lab)).rejects.toThrow(
      "invalid secret environment",
    );
    runtime.config.secretEnvironment = [];
    fixture.lab.composeEnvironment = ["TERM"];
    fixture.lab.secretEnvironment = ["TERM"];
    await expect(writeLab(fixture.roots, fixture.lab)).rejects.toThrow(
      "overlapping environment metadata",
    );
  });
});
